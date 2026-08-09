// engine/src/config.h
//
// bg_engine channel configuration (DEVELOPMENT_PROMPT §9.5).
//
// Parsed from CLI flags (with BG_ENGINE_* env fallbacks). One bg_engine process
// = one channel = one primary consumer (+ optional JPEG preview parallel).

#ifndef BG_ENGINE_CONFIG_H
#define BG_ENGINE_CONFIG_H

#include <cstdint>
#include <string>

namespace bg {

enum class ConsumerKind {
    Null,       // bench / headless
    Pipe,       // raw BGRA -> fd/file (debug with ffplay)
    Preview,    // throttled JPEG -> file
    Decklink,   // SDI Fill+Key (Phase 3, needs HW)
    Stream,     // ffmpeg SRT/RTMP (Phase 5)
};

enum class KeyerMode {
    FillOnly,
    Internal,
    External,
};

struct Config {
    // Page / sizing.
    std::string url = "http://localhost:3001/channel.html?engine=1";
    std::string name = "bg_engine";          // log label + cache dir basename
    int  width  = 1920;
    int  height = 1080;
    int  fps    = 50;

    // Run control.
    int  duration_sec      = 0;              // 0 = infinite
    int  stats_interval_sec = 5;

    // Consumer selection.
    ConsumerKind consumer = ConsumerKind::Null;

    // Unique per-channel cache dir (avoids Chromium process singleton).
    // DEVELOPMENT_PROMPT §9.2: cache-path MUST be unique per channel.
    std::string cache_dir;

    // Preview (PreviewWriter).
    std::string preview_out;                 // JPEG path; empty = none
    int  preview_fps = 10;

    // Pipe.
    std::string pipe_out;                    // file path; empty = stdout (fd 1)

    // DeckLink (Phase 3).
    int         device_index  = -1;          // -1 = none
    std::string display_mode  = "HD1080i50"; // BMD display mode name
    KeyerMode   keyer         = KeyerMode::External;

    // Stream (Phase 5).
    std::string stream_url;                  // srt://... | rtmp://...

    // Chrome DevTools protocol (research/diagnostics only). 0 = disabled.
    int remote_debugging_port = 0;

    // Blink pipeline research (Phase 12b). 0=off, 1=trace+invalidation categories,
    // 2=+PaintUnderInvalidationChecking (dev-only, may assert on null bench).
    int blink_research = 0;

    // Phase 17 P0: optional per-frame CSV diagnostic log (pump_active_us /
    // paint_latency_us). Empty = disabled (default, zero overhead on the
    // production decklink/browser paths).
    std::string frame_log;

    // P20.1: full schedule/completion provenance. Empty keeps the DeckLink
    // callback path unchanged.
    std::string decklink_completion_log;

    // Phase 19 doc 03: DeckLink-only fast path. Deliver an OnPaint buffer
    // synchronously into DecklinkConsumer::OnFrame, which immediately copies
    // it into owned queue storage. This eliminates the intermediate FrameRing
    // copy while never retaining the CEF pointer after OnPaint returns.
    bool decklink_direct_paint = false;

    // Phase 19 Doc02 PR5: full-path layered compositor. When true, the engine
    // captures per-layer CEF snapshots (via DOM visibility filters), caches
    // cacheable sources, and publishes composed frames through FrameRing
    // instead of the monolithic OnPaint. Default off; unsupported graphs and
    // capture failures fall back to the legacy monolith automatically.
    bool layered_compositor = false;

    // Parse argv into this config. Returns false on a fatal parse error (and
    // prints usage to stderr). Exits the process on --help / a missing required
    // arg so callers don't need to branch.
    bool Parse(int argc, char** argv);

    // Human-readable dump for the startup log line.
    std::string Describe() const;
};

// String helpers for logs.
const char* ConsumerLabel(ConsumerKind k);
const char* KeyerLabel(KeyerMode k);

}  // namespace bg

#endif  // BG_ENGINE_CONFIG_H
