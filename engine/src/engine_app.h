// engine/src/engine_app.h
//
// CefApp + render-process handler for bg_engine.
//
// Reimplemented by reference from CasparCG modules/html/html.cpp
// (renderer_application + init/uninit, CASPARRCG_PORTING.md §2):
//   - OnBeforeCommandLineProcessing pins the CPU-only OSR flags
//   - BrowserProcessSubsystem sets nothing (we use Alloy/single-process)
//
// CPU-only switches (DEVELOPMENT_PROMPT §9.2, REQ-3):
//   --disable-gpu --disable-gpu-compositing --disable-gpu-vsync
//   --ozone-platform=headless (when no DISPLAY) --enable-begin-frame-scheduling
//   --autoplay-policy=no-user-gesture-required --disable-web-security

#ifndef BG_ENGINE_ENGINE_APP_H
#define BG_ENGINE_ENGINE_APP_H

#include "include/cef_app.h"

namespace bg {

// CefApp for the browser process. Installs the CPU-only command-line switches
// and the external begin-frame scheduling flag that drives OSR painting on the
// channel fps.
class EngineApp : public CefApp,
                  public CefBrowserProcessHandler {
  public:
    EngineApp() = default;

    // CefApp
    CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
        return this;
    }

    // Pin command-line switches before any Chromium subprocess is spawned.
    void OnBeforeCommandLineProcessing(const CefString& process_type,
                                       CefRefPtr<CefCommandLine> command_line) override;

  private:
    IMPLEMENT_REFCOUNTING(EngineApp);
    DISALLOW_COPY_AND_ASSIGN(EngineApp);
};

// One-time CEF initialization for the process. CefInitialize + a message loop
// started by the caller (multi_threaded_message_loop=false; we pump with
// CefDoMessageLoopWork on our own tick — see message_pump.h).
// Returns false on CefInitialize failure.
bool EngineInit(CefMainArgs& main_args, const std::string& cache_dir);

// Shutdown CEF (CefShutdown). Idempotent.
void EngineShutdown();

}  // namespace bg

#endif  // BG_ENGINE_ENGINE_APP_H
