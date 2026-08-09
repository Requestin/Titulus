// engine/src/engine_client.h
//
// CefClient + CefRenderHandler for bg_engine.
//
// Reimplemented by reference from CasparCG modules/html/producer/html_producer.cpp
// (html_client: GetViewRect/GetScreenInfo/OnPaint/OnLoadingStateChange,
// CASPARRCG_PORTING.md §2). The OSR OnPaint path mirrors html_producer.cpp:347-399:
//   - filter PET_VIEW only (ignore PET_POPUP)
//   - copy BGRA into the FrameRing (single memcpy on Linux, no tbb parallel_for)
//   - device_scale_factor = 1.0 (kills the legacy 1919x1079 rounding artifact)

#ifndef BG_ENGINE_ENGINE_CLIENT_H
#define BG_ENGINE_ENGINE_CLIENT_H

#include "frame_ring.h"
#include "pacing_message_parser.h"
#include "include/cef_client.h"
#include "include/cef_request_handler.h"
#include "mixer/render_graph_store.h"
#include "compositor/live_pipeline.h"

#include <atomic>
#include <cstdint>
#include <functional>

namespace bg {

class EngineClient : public CefClient,
                     public CefRenderHandler,
                     public CefLifeSpanHandler,
                     public CefLoadHandler,
                     public CefDisplayHandler,
                     public CefRequestHandler {
  public:
    using OnPaintFn  = std::function<void(const uint8_t* bgra, int width, int height)>;
    using OnReadyFn  = std::function<void(bool ready)>;

    EngineClient(int width, int height, OnPaintFn on_paint, OnReadyFn on_ready)
        : width_(width), height_(height),
          on_paint_(std::move(on_paint)), on_ready_(std::move(on_ready)) {}

    // Doc02 PR3: attach a shadow RenderGraphStore so BGGRAPH v1 messages from
    // the page are recorded. Ownership stays with the caller; must outlive
    // every OnConsoleMessage call.
    void set_graph_store(RenderGraphStore* store) { graph_store_ = store; }
    RenderGraphStore* graph_store() const { return graph_store_; }

    // Doc02 PR5: attach the live layered pipeline so OnPaint can be redirected
    // into per-layer capture / live-overlay paths.
    void set_live_pipeline(compositor::LivePipeline* pipeline) {
        live_pipeline_ = pipeline;
    }
    compositor::LivePipeline* live_pipeline() const { return live_pipeline_; }

    // CefClient
    CefRefPtr<CefRenderHandler>    GetRenderHandler() override    { return this; }
    CefRefPtr<CefLifeSpanHandler>  GetLifeSpanHandler() override  { return this; }
    CefRefPtr<CefLoadHandler>      GetLoadHandler() override      { return this; }
    CefRefPtr<CefDisplayHandler>   GetDisplayHandler() override   { return this; }
    CefRefPtr<CefRequestHandler>   GetRequestHandler() override   { return this; }

    // CefDisplayHandler — forward only page console messages tagged with the
    // "BGSTATS" marker to stderr (Phase 19 doc 01 runtime instrumentation).
    // Filtering keeps Chromium's own chatty console output out of the log.
    bool OnConsoleMessage(CefRefPtr<CefBrowser> browser, cef_log_severity_t level,
                          const CefString& message, const CefString& source,
                          int line) override;

    // CefRenderHandler
    void GetViewRect(CefRefPtr<CefBrowser> browser, CefRect& rect) override;
    bool GetScreenInfo(CefRefPtr<CefBrowser> browser, CefScreenInfo& info) override;
    void OnPaint(CefRefPtr<CefBrowser> browser, PaintElementType type,
                 const RectList& dirty_rects, const void* buffer,
                 int width, int height) override;

    // CefLifeSpanHandler
    void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
    void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;

    // CefLoadHandler
    void OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                              bool isLoading, bool canGoBack,
                              bool canGoForward) override;
    void OnLoadError(CefRefPtr<CefBrowser> browser, CefRefPtr<CefFrame> frame,
                     ErrorCode errorCode, const CefString& errorText,
                     const CefString& failedUrl) override;

    // CefRequestHandler — surface renderer death with browser identity and
    // Chromium's termination status so the canonical harness can fail closed.
    void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                   TerminationStatus status,
                                   int error_code,
                                   const CefString& error_string) override;

    bool closing() const { return closing_.load(std::memory_order_acquire); }
    void set_closing()   { closing_.store(true, std::memory_order_release); }
    uint64_t cef_paint_seq() const {
        return cef_paint_seq_.load(std::memory_order_acquire);
    }
    RuntimePacingSnapshot pacing_snapshot() const {
        return pacing_store_.Snapshot();
    }
    uint64_t pacing_malformed_count() const {
        return pacing_malformed_count_.load(std::memory_order_acquire);
    }

    // Browser handle for the main pump. Set on OnAfterCreated, cleared on
    // OnBeforeClose; both run on the CEF UI thread, which IS the main thread
    // in our single-threaded message-loop mode, so no locking is needed.
    CefRefPtr<CefBrowser> browser() const { return browser_; }

  private:
    IMPLEMENT_REFCOUNTING(EngineClient);
    DISALLOW_COPY_AND_ASSIGN(EngineClient);

    int            width_;
    int            height_;
    OnPaintFn      on_paint_;
    OnReadyFn      on_ready_;
    RenderGraphStore* graph_store_ = nullptr;  // shadow only, never null-checked on hot path
    compositor::LivePipeline* live_pipeline_ = nullptr;
    std::atomic<bool> closing_{false};
    std::atomic<uint64_t> cef_paint_seq_{0};
    RuntimePacingStore pacing_store_;
    std::atomic<uint64_t> pacing_malformed_count_{0};
    CefRefPtr<CefBrowser> browser_;
};

}  // namespace bg

#endif  // BG_ENGINE_ENGINE_CLIENT_H
