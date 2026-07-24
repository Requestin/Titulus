// engine/src/vs/config_vs.cpp

#include "vs/config_vs.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sstream>

namespace bg {
namespace vs {

namespace {

bool match_prefix(const char* arg, const char* key, std::string& val, int& i, int argc, char** argv) {
    const size_t n = std::strlen(key);
    if (std::strncmp(arg, key, n) != 0) return false;
    if (arg[n] == '=') {
        val = arg + n + 1;
        return true;
    }
    if (arg[n] == '\0' && i + 1 < argc) {
        val = argv[++i];
        return true;
    }
    return false;
}

void usage() {
    std::fprintf(stderr,
        "bg_vs_engine — Titulus Virtual Studio compositor\n"
        "  --name=LABEL\n"
        "  --width=1920 --height=1080 --fps=50\n"
        "  --consumer=null|pipe|preview|decklink|stream\n"
        "  --device-index=N --display-mode=HD1080i50 --keyer=fill_only|external|internal\n"
        "  --vs-input-device=N   DeckLink camera input (-1 = file/stub)\n"
        "  --cam-file=PATH --bg-file=PATH --ndi-source=NAME\n"
        "  --key-color=green|blue --similarity=0.35 --smoothness=0.08 --spill=0.4\n"
        "  --passthrough        BG only (no chroma)\n"
        "  --duration=SEC --stats-interval=SEC\n"
        "  --pipe-out=PATH --preview-out=PATH --stream-url=URL\n"
        "Docs: docs/unreal-vs-mode.md\n");
}

}  // namespace

bool VsConfig::Parse(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        const char* arg = argv[i];
        if (std::strcmp(arg, "-h") == 0 || std::strcmp(arg, "--help") == 0) {
            usage();
            std::exit(0);
        }
        std::string val;
        if (match_prefix(arg, "--name", val, i, argc, argv)) { name = val; continue; }
        if (match_prefix(arg, "--width", val, i, argc, argv)) { width = std::atoi(val.c_str()); continue; }
        if (match_prefix(arg, "--height", val, i, argc, argv)) { height = std::atoi(val.c_str()); continue; }
        if (match_prefix(arg, "--fps", val, i, argc, argv)) { fps = std::atoi(val.c_str()); continue; }
        if (match_prefix(arg, "--duration", val, i, argc, argv)) { duration_sec = std::atoi(val.c_str()); continue; }
        if (match_prefix(arg, "--stats-interval", val, i, argc, argv)) {
            stats_interval_sec = std::atoi(val.c_str()); continue;
        }
        if (match_prefix(arg, "--consumer", val, i, argc, argv)) {
            if (val == "null") consumer = ConsumerKind::Null;
            else if (val == "pipe") consumer = ConsumerKind::Pipe;
            else if (val == "preview") consumer = ConsumerKind::Preview;
            else if (val == "decklink") consumer = ConsumerKind::Decklink;
            else if (val == "stream") consumer = ConsumerKind::Stream;
            else {
                std::fprintf(stderr, "bg_vs_engine: unknown --consumer=%s\n", val.c_str());
                return false;
            }
            continue;
        }
        if (match_prefix(arg, "--pipe-out", val, i, argc, argv)) { pipe_out = val; continue; }
        if (match_prefix(arg, "--preview-out", val, i, argc, argv)) { preview_out = val; continue; }
        if (match_prefix(arg, "--preview-fps", val, i, argc, argv)) {
            preview_fps = std::atoi(val.c_str()); continue;
        }
        if (match_prefix(arg, "--device-index", val, i, argc, argv)) {
            device_index = std::atoi(val.c_str()); continue;
        }
        if (match_prefix(arg, "--display-mode", val, i, argc, argv)) { display_mode = val; continue; }
        if (match_prefix(arg, "--keyer", val, i, argc, argv)) {
            if (val == "external") keyer = KeyerMode::External;
            else if (val == "internal") keyer = KeyerMode::Internal;
            else if (val == "fill_only") keyer = KeyerMode::FillOnly;
            else {
                std::fprintf(stderr, "bg_vs_engine: unknown --keyer=%s\n", val.c_str());
                return false;
            }
            continue;
        }
        if (match_prefix(arg, "--stream-url", val, i, argc, argv)) { stream_url = val; continue; }
        if (match_prefix(arg, "--vs-input-device", val, i, argc, argv)) {
            vs_input_device = std::atoi(val.c_str()); continue;
        }
        if (match_prefix(arg, "--cam-file", val, i, argc, argv)) { cam_file = val; continue; }
        if (match_prefix(arg, "--bg-file", val, i, argc, argv)) { bg_file = val; continue; }
        if (match_prefix(arg, "--ndi-source", val, i, argc, argv)) { ndi_source = val; continue; }
        if (match_prefix(arg, "--key-color", val, i, argc, argv)) { key_color = val; continue; }
        if (match_prefix(arg, "--similarity", val, i, argc, argv)) {
            similarity = static_cast<float>(std::atof(val.c_str())); continue;
        }
        if (match_prefix(arg, "--smoothness", val, i, argc, argv)) {
            smoothness = static_cast<float>(std::atof(val.c_str())); continue;
        }
        if (match_prefix(arg, "--spill", val, i, argc, argv)) {
            spill = static_cast<float>(std::atof(val.c_str())); continue;
        }
        if (std::strcmp(arg, "--passthrough") == 0) { passthrough = true; continue; }

        std::fprintf(stderr, "bg_vs_engine: unknown arg %s\n", arg);
        usage();
        return false;
    }
    if (width <= 0 || height <= 0 || fps <= 0) {
        std::fprintf(stderr, "bg_vs_engine: invalid width/height/fps\n");
        return false;
    }
    if (consumer == ConsumerKind::Stream && stream_url.empty()) {
        std::fprintf(stderr, "bg_vs_engine: --stream-url required for stream consumer\n");
        return false;
    }
    return true;
}

std::string VsConfig::Describe() const {
    std::ostringstream os;
    os << name << " " << width << "x" << height << "@" << fps
       << " consumer=" << ConsumerLabel(consumer)
       << " cam_in=" << vs_input_device
       << " ndi=" << (ndi_source.empty() ? "(stub)" : ndi_source)
       << (passthrough ? " passthrough" : " chroma");
    return os.str();
}

}  // namespace vs
}  // namespace bg
