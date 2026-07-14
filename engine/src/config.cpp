// engine/src/config.cpp — CLI parsing for bg_engine. See config.h.

#include "config.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace bg {

namespace {

// Read an env var with the BG_ENGINE_ prefix, returning the CLI default if unset.
const char* env_or(const char* key, const char* fallback) {
    std::string full = std::string("BG_ENGINE_") + key;
    if (const char* v = std::getenv(full.c_str())) return v;
    return fallback;
}

void print_usage() {
    std::fputs(
        "bg_engine — Titulus render host (one CasparCG-class channel per process)\n"
        "\n"
        "Usage: bg_engine [options]\n"
        "\n"
        "Page / sizing:\n"
        "  --url=URL                 page to render (default channel.html?engine=1)\n"
        "  --name=STR                log label / cache-dir basename\n"
        "  --width=N --height=N      output size (default 1920x1080)\n"
        "  --fps=N                   channel fps (default 50)\n"
        "\n"
        "Run control:\n"
        "  --duration=SEC            0 = infinite (bench uses 60)\n"
        "  --stats-interval=SEC      periodic stats log (default 5)\n"
        "\n"
        "Consumer:\n"
        "  --consumer=null|pipe|preview|decklink|stream   (default null)\n"
        "  --cache-dir=DIR           REQUIRED unique per channel\n"
        "\n"
        "Preview (with --consumer=preview or always-on side JPEG):\n"
        "  --preview-out=PATH        JPEG output path\n"
        "  --preview-fps=N           throttle (default 10)\n"
        "\n"
        "Pipe (--consumer=pipe):\n"
        "  --out=FILE                raw BGRA file (default stdout)\n"
        "\n"
        "DeckLink (--consumer=decklink, Phase 3, needs HW):\n"
        "  --device-index=N          DeckLink sub-device (-1 = none)\n"
        "  --display-mode=NAME       HD1080i50, HD1080p50, HD720p60, ...\n"
        "  --keyer=external|internal|fill_only\n"
        "  --decklink-direct-paint  bypass FrameRing for DeckLink (research flag)\n"
        "\n"
        "Stream (--consumer=stream, Phase 5):\n"
        "  --stream-url=URL          srt://... | rtmp://...\n"
        "\n"
        "Diagnostics (research only):\n"
        "  --remote-debugging-port=N Chrome DevTools port (0=off)\n"
        "  --blink-research=N        0=off 1=trace+invalidation 2=+paint check\n"
        "  --frame-log=PATH          per-frame CSV (pump_active_us/paint_latency_us), off by default\n"
        "\n"
        "Environment fallbacks: BG_ENGINE_URL, BG_ENGINE_NAME, BG_ENGINE_CACHE_DIR, ...\n",
        stderr);
}

// --key=value and --key value are both accepted.
bool match_prefix(const char* arg, const char* prefix, std::string& out_val, int& i,
                  int argc, char** argv) {
    size_t plen = std::strlen(prefix);
    if (std::strncmp(arg, prefix, plen) != 0) return false;
    if (arg[plen] == '=') {
        out_val = arg + plen + 1;
        return true;
    }
    if (arg[plen] == '\0') {
        // --key value form
        if (i + 1 >= argc) return false;
        out_val = argv[++i];
        return true;
    }
    return false;
}

long parse_int(const std::string& s, bool& ok) {
    ok = true;
    try {
        size_t pos = 0;
        long v = std::stol(s, &pos);
        if (pos != s.size()) ok = false;
        return v;
    } catch (...) {
        ok = false;
        return 0;
    }
}

}  // namespace

const char* ConsumerLabel(ConsumerKind k) {
    switch (k) {
        case ConsumerKind::Null:     return "null";
        case ConsumerKind::Pipe:     return "pipe";
        case ConsumerKind::Preview:  return "preview";
        case ConsumerKind::Decklink: return "decklink";
        case ConsumerKind::Stream:   return "stream";
    }
    return "?";
}

const char* KeyerLabel(KeyerMode k) {
    switch (k) {
        case KeyerMode::FillOnly: return "fill_only";
        case KeyerMode::Internal: return "internal";
        case KeyerMode::External: return "external";
    }
    return "?";
}

bool Config::Parse(int argc, char** argv) {
    // Apply BG_ENGINE_* env defaults first.
    url             = env_or("URL",          url.c_str());
    name            = env_or("NAME",         name.c_str());
    cache_dir       = env_or("CACHE_DIR",    cache_dir.c_str());
    preview_out     = env_or("PREVIEW_OUT",  preview_out.c_str());
    stream_url      = env_or("STREAM_URL",   stream_url.c_str());
    frame_log       = env_or("FRAME_LOG",    frame_log.c_str());
    if (const char* v = std::getenv("BG_DECKLINK_DIRECT_PAINT")) {
        decklink_direct_paint = std::atoi(v) != 0;
    }
    if (const char* v = std::getenv("BG_ENGINE_FPS"))        fps    = std::atoi(v);
    if (const char* v = std::getenv("BG_ENGINE_WIDTH"))      width  = std::atoi(v);
    if (const char* v = std::getenv("BG_ENGINE_HEIGHT"))     height = std::atoi(v);

    for (int i = 1; i < argc; ++i) {
        const char* arg = argv[i];
        std::string val;
        bool ok = true;

        if (std::strcmp(arg, "-h") == 0 || std::strcmp(arg, "--help") == 0) {
            print_usage();
            std::exit(0);
        }
        if (std::strcmp(arg, "--decklink-direct-paint") == 0) {
            decklink_direct_paint = true;
            continue;
        }
        if (match_prefix(arg, "--url",           val, i, argc, argv)) { url = val; continue; }
        if (match_prefix(arg, "--name",          val, i, argc, argv)) { name = val; continue; }
        if (match_prefix(arg, "--cache-dir",     val, i, argc, argv)) { cache_dir = val; continue; }
        if (match_prefix(arg, "--preview-out",   val, i, argc, argv)) { preview_out = val; continue; }
        if (match_prefix(arg, "--out",           val, i, argc, argv)) { pipe_out = val; continue; }
        if (match_prefix(arg, "--display-mode",  val, i, argc, argv)) { display_mode = val; continue; }
        if (match_prefix(arg, "--stream-url",    val, i, argc, argv)) { stream_url = val; continue; }
        if (match_prefix(arg, "--frame-log",     val, i, argc, argv)) { frame_log = val; continue; }
        if (match_prefix(arg, "--consumer",      val, i, argc, argv)) {
            if      (val == "null")     consumer = ConsumerKind::Null;
            else if (val == "pipe")     consumer = ConsumerKind::Pipe;
            else if (val == "preview")  consumer = ConsumerKind::Preview;
            else if (val == "decklink") consumer = ConsumerKind::Decklink;
            else if (val == "stream")   consumer = ConsumerKind::Stream;
            else { std::fprintf(stderr, "bg_engine: unknown --consumer=%s\n", val.c_str()); return false; }
            continue;
        }
        if (match_prefix(arg, "--keyer",         val, i, argc, argv)) {
            if      (val == "external")  keyer = KeyerMode::External;
            else if (val == "internal")  keyer = KeyerMode::Internal;
            else if (val == "fill_only") keyer = KeyerMode::FillOnly;
            else { std::fprintf(stderr, "bg_engine: unknown --keyer=%s\n", val.c_str()); return false; }
            continue;
        }
        if (match_prefix(arg, "--width",          val, i, argc, argv)) { width  = parse_int(val, ok); }
        else if (match_prefix(arg, "--height",     val, i, argc, argv)) { height = parse_int(val, ok); }
        else if (match_prefix(arg, "--fps",        val, i, argc, argv)) { fps    = parse_int(val, ok); }
        else if (match_prefix(arg, "--duration",   val, i, argc, argv)) { duration_sec     = parse_int(val, ok); }
        else if (match_prefix(arg, "--stats-interval", val, i, argc, argv)) { stats_interval_sec = parse_int(val, ok); }
        else if (match_prefix(arg, "--preview-fps",val, i, argc, argv)) { preview_fps      = parse_int(val, ok); }
        else if (match_prefix(arg, "--device-index", val, i, argc, argv)) { device_index = parse_int(val, ok); }
        else if (match_prefix(arg, "--remote-debugging-port", val, i, argc, argv)) { remote_debugging_port = parse_int(val, ok); }
        else if (match_prefix(arg, "--blink-research", val, i, argc, argv)) { blink_research = parse_int(val, ok); }
        else {
            std::fprintf(stderr, "bg_engine: unknown option '%s' (try --help)\n", arg);
            return false;
        }
        if (!ok) {
            std::fprintf(stderr, "bg_engine: invalid integer for '%s'\n", arg);
            return false;
        }
    }

    // Validate.
    if (width <= 0 || height <= 0 || fps <= 0) {
        std::fprintf(stderr, "bg_engine: invalid geometry %dx%d@%d\n", width, height, fps);
        return false;
    }
    if (cache_dir.empty()) {
        std::fprintf(stderr, "bg_engine: --cache-dir is REQUIRED (unique per channel)\n");
        return false;
    }
    if (consumer == ConsumerKind::Decklink && device_index < 0) {
        std::fprintf(stderr, "bg_engine: decklink consumer needs --device-index=N\n");
        return false;
    }
    if (decklink_direct_paint && consumer != ConsumerKind::Decklink) {
        std::fprintf(stderr, "bg_engine: --decklink-direct-paint requires --consumer=decklink\n");
        return false;
    }
    if (consumer == ConsumerKind::Stream && stream_url.empty()) {
        std::fprintf(stderr, "bg_engine: stream consumer needs --stream-url=URL\n");
        return false;
    }
    return true;
}

std::string Config::Describe() const {
    char buf[512];
    std::snprintf(buf, sizeof(buf),
                  "name=%s %dx%d@%dfps consumer=%s direct_paint=%s cache=%s url=%s duration=%ds",
                  name.c_str(), width, height, fps,
                  ConsumerLabel(consumer), decklink_direct_paint ? "on" : "off",
                  cache_dir.c_str(), url.c_str(), duration_sec);
    return buf;
}

}  // namespace bg
