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
#include "include/cef_client.h"

#include <atomic>
#include <functional>

namespace bg {

class EngineClient : public CefClient,
                     public CefRenderHandler,
                     public CefLifeSpanHandler,
                     public CefLoadHandler,
                     public CefDisplayHandler {
  public:
    using OnPaintFn  = std::function<void(const uint8_t* bgra, int width, int height)>;
    using OnReadyFn  = std::function<void(bool ready)>;

    EngineClient(int width, int height, OnPaintFn on_paint, OnReadyFn on_ready)
        : width_(width), height_(height),
          on_paint_(std::move(on_paint)), on_ready_(std::move(on_ready)) {}

    // CefClient
    CefRefPtr<CefRenderHandler>    GetRenderHandler() override    { return this; }
    CefRefPtr<CefLifeSpanHandler>  GetLifeSpanHandler() override  { return this; }
    CefRefPtr<CefLoadHandler>      GetLoadHandler() override      { return this; }
    CefRefPtr<CefDisplayHandler>   GetDisplayHandler() override   { return this; }

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

    bool closing() const { return closing_.load(std::memory_order_acquire); }
    void set_closing()   { closing_.store(true, std::memory_order_release); }

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
    std::atomic<bool> closing_{false};
    CefRefPtr<CefBrowser> browser_;
};

}  // namespace bg

#endif  // BG_ENGINE_ENGINE_CLIENT_H
