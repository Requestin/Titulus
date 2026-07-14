// engine/src/engine_client.cpp — see engine_client.h.

#include "engine_client.h"

#include <cstdio>
#include <cstring>

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
                           const RectList&, const void* buffer,
                           int width, int height) {
    if (closing_.load(std::memory_order_acquire)) return;
    // Only the view surface, never popups (CasparCG html_producer.cpp:361).
    if (type != PET_VIEW) return;

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
    if (on_ready_) on_ready_(true);
}

void EngineClient::OnBeforeClose(CefRefPtr<CefBrowser>) {
    browser_ = nullptr;
    closing_.store(true, std::memory_order_release);
}

void EngineClient::OnLoadingStateChange(CefRefPtr<CefBrowser>,
                                        bool isLoading, bool, bool) {
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
    // Only surface opt-in runtime stats lines (channel.html emits these when
    // ?stats=1). Everything else stays swallowed so the engine log is clean.
    if (msg.rfind("BGSTATS", 0) == 0) {
        std::fprintf(stderr, "bg_engine[runtime]: %s\n", msg.c_str());
        return true;
    }
    return false;
}

}  // namespace bg
