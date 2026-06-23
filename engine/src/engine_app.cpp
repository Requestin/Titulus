// engine/src/engine_app.cpp — see engine_app.h.
//
// Reimplemented by reference from CasparCG modules/html/html.cpp:
//   - OnBeforeCommandLineProcessing @ html.cpp:171-211
//   - init() CefSettings @ html.cpp:227-256
//   - uninit() @ html.cpp:274-282
// No CasparCG code is linked or shipped; only the algorithm is mirrored.

#include "engine_app.h"

#include <cstdlib>  // getenv

namespace bg {

void EngineApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                              CefRefPtr<CefCommandLine> cmd) {
    // CasparCG applies begin-frame-scheduling + autoplay for every process
    // type; we do the same so render-process subprocesses inherit the flags.
    cmd->AppendSwitch("enable-begin-frame-scheduling");
    cmd->AppendSwitchWithValue("autoplay-policy", "no-user-gesture-required");
    // The channel page may load media from the backend origin over http in dev;
    // CasparCG sets this for template-host convenience.
    cmd->AppendSwitch("disable-web-security");

#if defined(__linux__)
    // Without an X server, Chromium's UI compositor needs the Ozone headless
    // platform. (Do NOT use Chromium's --headless shell: it breaks CEF Alloy
    // OSR — DEVELOPMENT_PROMPT §9.2.) CasparCG html.cpp:190-194.
    if (std::getenv("DISPLAY") == nullptr) {
        cmd->AppendSwitchWithValue("ozone-platform", "headless");
    }
#endif

    // CPU-only path (DEVELOPMENT_PROMPT §0.2.1, REQ-3): disable GPU everywhere.
    // GPU is only ever enabled through a GPU Gate doc; there is no such gate
    // in the MVP, so these switches are unconditional.
    if (process_type.empty()) {  // browser process
        cmd->AppendSwitch("disable-gpu");
        cmd->AppendSwitch("disable-gpu-compositing");
        cmd->AppendSwitchWithValue("disable-gpu-vsync", "gpu");
    }
}

bool EngineInit(CefMainArgs& main_args, const std::string& cache_dir) {
    CefSettings settings;
    // OSR (windowless) rendering mode — DEVELOPMENT_PROMPT §9.2.
    settings.windowless_rendering_enabled = true;
    // No sandbox: the engine runs on a dedicated channel with pinned cores and
    // its own cache dir; the Chromium sandbox adds overhead with no isolation
    // benefit for a single-template render host. CasparCG html.cpp:241.
    settings.no_sandbox = true;
    // Let the CEF command-line switches (above) take effect.
    settings.command_line_args_disabled = false;
    // Single-process mode by default keeps per-channel overhead low
    // (DEVELOPMENT_PROMPT §9.2). Caller can flip to multi-process via --multi-process.
    // (We leave the default which CEF exposes as a switch we honor in main.cpp.)

    // Unique per-channel cache path — MANDATORY for multi-channel (avoids the
    // Chromium user-data process singleton). CasparCG html.cpp:245-252.
    if (!cache_dir.empty()) {
        CefString(&settings.cache_path) = cache_dir;
    }

    return CefInitialize(main_args, settings, new EngineApp(), nullptr);
}

void EngineShutdown() {
    CefShutdown();
}

}  // namespace bg
