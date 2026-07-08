// engine/src/engine_app.cpp — see engine_app.h.
//
// Reimplemented by reference from CasparCG modules/html/html.cpp:
//   - OnBeforeCommandLineProcessing @ html.cpp:171-211
//   - init() CefSettings @ html.cpp:227-256
//   - uninit() @ html.cpp:274-282
// No CasparCG code is linked or shipped; only the algorithm is mirrored.

#include "engine_app.h"

#include <cstdlib>  // getenv
#include <string>

namespace bg {

namespace {
// When remote debugging is enabled for research, record a startup trace into
// the per-channel cache dir (Chromium trace-startup-* switches).
std::string g_trace_startup_file;
int g_trace_startup_seconds = 0;
int g_blink_research = 0;

const char* kDefaultTraceStartupCategories =
    "blink,cc,devtools.timeline,disabled-by-default-devtools.timeline,"
    "disabled-by-default-devtools.timeline.invalidationTracking,"
    "disabled-by-default-devtools.timeline.frame,"
    "disabled-by-default-v8.cpu_profiler,v8";

// Phase 15 P0: allow overriding the trace categories/duration without a
// rebuild, so soak runs on the live decklink channels can capture longer /
// differently-scoped traces (e.g. to isolate the mask raster cost, class B)
// without needing a remote-debugging port open. Empty env = keep defaults.
const char* TraceCategories() {
    if (const char* v = std::getenv("BG_TRACE_CATEGORIES")) return v;
    return kDefaultTraceStartupCategories;
}

// Returns the env-var override for trace duration, or 0 if unset/invalid.
int TraceSecondsOverride() {
    if (const char* v = std::getenv("BG_TRACE_SECONDS")) {
        int secs = std::atoi(v);
        if (secs > 0) return secs;
    }
    return 0;
}

// Phase 17 P0-b: env-only override for Chromium's raster thread pool size
// (renderer process). Unset by default — Chromium picks its own default (2
// on this host) — so production decklink/browser channels are unaffected
// until a Phase 17 A/B experiment explicitly sets this. Returns empty string
// if unset/invalid.
std::string NumRasterThreadsOverride() {
    if (const char* v = std::getenv("BG_NUM_RASTER_THREADS")) {
        if (std::atoi(v) > 0) return v;
    }
    return "";
}
}  // namespace

void EngineApp::OnBeforeCommandLineProcessing(const CefString& process_type,
                                              CefRefPtr<CefCommandLine> cmd) {
    // CasparCG applies begin-frame-scheduling + autoplay for every process
    // type; we do the same so render-process subprocesses inherit the flags.
    cmd->AppendSwitch("enable-begin-frame-scheduling");
    cmd->AppendSwitchWithValue("autoplay-policy", "no-user-gesture-required");
    // The channel page may load media from the backend origin over http in dev;
    // CasparCG sets this for template-host convenience.
    cmd->AppendSwitch("disable-web-security");

    // Phase 17 P0-b: optional override of Chromium's raster worker pool size
    // (renderer-process compositor). No-op unless BG_NUM_RASTER_THREADS is
    // set — Chromium's own default (2 on this host, unset otherwise) is
    // unaffected in production. Applied for every process type like the
    // switches above so the renderer subprocess (where rasterization
    // actually happens) picks it up.
    const std::string num_raster_threads = NumRasterThreadsOverride();
    if (!num_raster_threads.empty()) {
        cmd->AppendSwitchWithValue("num-raster-threads", num_raster_threads);
    }

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

        // Phase 11.6: an OSR (windowless) view has no real native window, so
        // Chromium's page-visibility/occlusion heuristics can misclassify it
        // as "backgrounded" the same way they would a minimized tab — which
        // throttles JS timers (setTimeout/setInterval clamped to ~1Hz) and
        // can lower the renderer process's scheduling priority. Neither is
        // acceptable for a channel that must render every field on time.
        // These flags are the standard fix for exactly this class of bug in
        // other CEF/Chromium OSR and headless-automation hosts (Puppeteer/
        // Playwright ship the same three for their headless mode). Verified
        // live: renderer processes on this host already showed nice=0 (not
        // yet hit in practice on Linux --no-sandbox), so this is a
        // zero-measured-regression defensive hardening, not a fix for an
        // observed bug — kept because the failure mode it guards against
        // (silent JS timer throttling) is exactly the kind of intermittent
        // judder that would be very hard to diagnose after the fact.
        cmd->AppendSwitch("disable-renderer-backgrounding");
        cmd->AppendSwitch("disable-backgrounding-occluded-windows");
        cmd->AppendSwitch("disable-background-timer-throttling");

        // Chrome trace for Blink/cc research (first N seconds after process
        // start). Gated on remote debugging (or blink_research, or an explicit
        // BG_TRACE_SECONDS env override) so production decklink paths stay
        // untouched unless explicitly opened for research.
        if (!g_trace_startup_file.empty() && g_trace_startup_seconds > 0) {
            cmd->AppendSwitchWithValue("trace-startup", TraceCategories());
            cmd->AppendSwitchWithValue("trace-startup-file", g_trace_startup_file);
            cmd->AppendSwitchWithValue("trace-startup-duration",
                                       std::to_string(g_trace_startup_seconds));
            cmd->AppendSwitchWithValue("trace-startup-format", "json");
        }
        // Dev-only paint invalidation consistency checks (null bench only).
        if (g_blink_research >= 2) {
            cmd->AppendSwitchWithValue("enable-blink-features",
                                       "PaintUnderInvalidationChecking");
        }
    }
}

bool EngineInit(CefMainArgs& main_args, const std::string& cache_dir,
                int remote_debugging_port, int blink_research) {
    g_blink_research = blink_research;
    CefSettings settings;
    // OSR (windowless) rendering mode — DEVELOPMENT_PROMPT §9.2.
    settings.windowless_rendering_enabled = true;
    // No sandbox: the engine runs on a dedicated channel with pinned cores and
    // its own cache dir; the Chromium sandbox adds overhead with no isolation
    // benefit for a single-template render host. CasparCG html.cpp:241.
    settings.no_sandbox = true;
    // Let the CEF command-line switches (above) take effect.
    settings.command_line_args_disabled = false;
    if (remote_debugging_port > 0) {
        settings.remote_debugging_port = remote_debugging_port;
    }
    const int trace_seconds_override = TraceSecondsOverride();
    if ((remote_debugging_port > 0 || blink_research > 0 || trace_seconds_override > 0)
        && !cache_dir.empty()) {
        g_trace_startup_file = cache_dir + "/blink-trace.json";
        // Phase 15 P0: BG_TRACE_SECONDS lets soak runs capture a trace window
        // longer than the 15s research default (still bounded — Chromium's
        // startup tracing buffers in memory, so keep this sane; 60s is the
        // largest window used by the Phase 15 baseline/soak scripts).
        g_trace_startup_seconds = trace_seconds_override > 0 ? trace_seconds_override : 15;
    }
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
