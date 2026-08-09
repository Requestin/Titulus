// engine/src/engine_client.cpp — see engine_client.h.

#include "engine_client.h"

#include "frame_log.h"
#include "mixer/graph_message_parser.h"
#include "mixer/render_graph_store.h"

#include <charconv>
#include <cstdio>
#include <cstring>
#include <utility>
#include <vector>

namespace bg {

void EngineClient::GetViewRect(CefRefPtr<CefBrowser>, CefRect& rect) {
    // Channel geometry is fixed (DEVELOPMENT_PROMPT §9.4: GetViewRect -> configured
    // width x height). The browser always renders the full channel frame.
    rect = CefRect(0, 0, width_, height_);
}

bool EngineClient::GetScreenInfo(CefRefPtr<CefBrowser>, CefScreenInfo& info) {
    // device_scale_factor = 1.0 — CasparCG html_producer forces this to avoid
    // the 1919x1079 rounding artifact on hi-DPI hosts. BGRA stride stays an
    // exact width*4 (DEVELOPMENT_PROMPT §3.4).
    info.device_scale_factor = 1.0f;
    info.rect = CefRect(0, 0, width_, height_);
    info.available_rect = info.rect;
    return true;
}

void EngineClient::OnPaint(CefRefPtr<CefBrowser>, PaintElementType type,
                           const RectList& dirty_rects, const void* buffer,
                           int width, int height) {
    if (closing_.load(std::memory_order_acquire)) return;
    // Only the view surface, never popups (CasparCG html_producer.cpp:361).
    if (type != PET_VIEW) return;
    cef_paint_seq_.fetch_add(1, std::memory_order_release);

    // Doc02 PR5: when the live pipeline is capturing or composing, it may
    // consume this paint instead of forwarding it to FrameRing.
    if (live_pipeline_) {
        std::vector<compositor::LayerDirtyRect> regions;
        regions.reserve(dirty_rects.size());
        for (const auto& rect : dirty_rects) {
            regions.push_back({
                rect.x, rect.y, rect.width, rect.height,
            });
        }
        const uint64_t seq = 0;  // main.cpp stamps paint_seq; pipeline uses wall seq
        auto disposition = live_pipeline_->OnPaint(
            static_cast<const uint8_t*>(buffer), width, height, seq, regions);
        using Disposition = compositor::PaintDisposition;
        switch (disposition) {
            case Disposition::ConsumedByCapture:
                return;
            case Disposition::ConsumedByCompose:
                // Signal the pump to ComposeInto + publish. Null buffer is a
                // sentinel understood by main.cpp::on_paint.
                if (on_paint_) on_paint_(nullptr, 0, 0);
                return;
            case Disposition::ForwardToRing:
                break;
        }
    }

    // Single BGRA memcpy on Linux — CasparCG html_producer.cpp:379-383 found the
    // tbb parallel_for unnecessary on Linux for a 1080p frame.
    const size_t bytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    if (on_paint_) {
        // Forward the raw BGRA to the engine pump, which copies into the
        // FrameRing (the CEF buffer is invalidated once OnPaint returns).
        on_paint_(static_cast<const uint8_t*>(buffer), width, height);
    }
    (void)bytes;
}

void EngineClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
    // Browser is up. The page will start painting once its DOM is ready and the
    // perpetual rAF heartbeat (channel.html) keeps the compositor ticking.
    browser_ = browser;
    if (live_pipeline_) live_pipeline_->set_browser(browser);
    if (on_ready_) on_ready_(true);
}

void EngineClient::OnBeforeClose(CefRefPtr<CefBrowser>) {
    browser_ = nullptr;
    closing_.store(true, std::memory_order_release);
}

void EngineClient::OnLoadingStateChange(CefRefPtr<CefBrowser>,
                                        bool isLoading, bool, bool) {
    if (isLoading) {
        // Graph revisions are scoped to one page instance. A reload restarts
        // ChannelClient's counter, so retaining the previous store would mark
        // every new snapshot stale and could keep old cached pixels on air.
        if (graph_store_) graph_store_->Reset();
        if (live_pipeline_ && live_pipeline_->enabled()) {
            live_pipeline_->set_enabled(false);
            live_pipeline_->set_enabled(true);
        }
    }
    // "Ready" here means the page finished its initial load; subsequent template
    // takes drive DOM mutation, not navigation.
    if (!isLoading && on_ready_) on_ready_(true);
}

void EngineClient::OnLoadError(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>,
                               ErrorCode errorCode, const CefString& errorText,
                               const CefString& failedUrl) {
    std::fprintf(stderr, "bg_engine: load error %d '%s' on %s\n",
                 static_cast<int>(errorCode),
                 errorText.ToString().c_str(),
                 failedUrl.ToString().c_str());
}

bool EngineClient::OnConsoleMessage(CefRefPtr<CefBrowser>, cef_log_severity_t,
                                    const CefString& message, const CefString&,
                                    int) {
    const std::string msg = message.ToString();
    constexpr std::string_view kCaptureReady = "BGCAPTURE_READY ";
    constexpr std::string_view kCaptureError = "BGCAPTURE_ERROR ";
    const auto capture_ack = [&](std::string_view prefix, bool ready) {
        if (msg.rfind(prefix, 0) != 0) return false;
        uint64_t seq = 0;
        const std::string_view value(msg.data() + prefix.size(),
                                     msg.size() - prefix.size());
        const auto parsed =
            std::from_chars(value.data(), value.data() + value.size(), seq);
        if (parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size()
            && live_pipeline_) {
            if (ready) live_pipeline_->OnCaptureReady(seq);
            else live_pipeline_->OnCaptureError(seq);
        }
        return true;
    };
    if (capture_ack(kCaptureReady, true) || capture_ack(kCaptureError, false)) {
        return true;
    }
    if (msg.rfind("BGPACING", 0) == 0) {
        const auto parsed = ParsePacingMessage(msg);
        if (parsed.status == PacingParseStatus::Ok) {
            const FrameLogClockSample clocks = CaptureFrameLogClocks();
            pacing_store_.Commit(
                parsed.event, clocks.unix_us, clocks.mono_us);
        } else {
            pacing_malformed_count_.fetch_add(1, std::memory_order_relaxed);
        }
        return true;
    }
    // Only surface opt-in runtime stats lines (channel.html emits these when
    // ?stats=1). Everything else stays swallowed so the engine log is clean.
    if (msg.rfind("BGSTATS", 0) == 0) {
        std::fprintf(stderr, "bg_engine[runtime]: %s\n", msg.c_str());
        return true;
    }
    // Doc02 PR3: forward BGGRAPH v1 snapshots to the shadow store. The store is
    // shadow-only; it never reaches the render pump. Failures are recorded as
    // counters so a paired K2 run can correlate spikes with malformed frames.
    if (msg.rfind("BGGRAPH", 0) == 0) {
        if (graph_store_) {
            auto parsed = bg::ParseGraphMessage(msg);
            switch (parsed.status) {
                case bg::GraphParseStatus::Ok:
                    graph_store_->Commit(std::move(parsed.snapshot));
                    break;
                case bg::GraphParseStatus::NotGraphMessage:
                    graph_store_->RecordUnsupported("header mismatch");
                    break;
                case bg::GraphParseStatus::MalformedJson:
                case bg::GraphParseStatus::MissingRequiredField:
                case bg::GraphParseStatus::UnsupportedFieldValue:
                case bg::GraphParseStatus::UnsupportedVersion:
                    graph_store_->RecordMalformed(parsed.error_detail);
                    break;
                case bg::GraphParseStatus::BoundsViolation:
                    graph_store_->RecordBoundsViolation(parsed.error_detail);
                    break;
            }
        }
        return true;  // swallow either way: graph traffic is opt-in telemetry
    }
    return false;
}

}  // namespace bg
