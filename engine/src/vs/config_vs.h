// engine/src/vs/config_vs.h — CLI for bg_vs_engine

#ifndef BG_VS_CONFIG_H
#define BG_VS_CONFIG_H

#include "config.h"  // ConsumerKind, KeyerMode

#include <string>

namespace bg {
namespace vs {

struct VsConfig {
    std::string name = "bg_vs_engine";
    int width = 1920;
    int height = 1080;
    int fps = 50;
    int duration_sec = 0;
    int stats_interval_sec = 5;

    ConsumerKind consumer = ConsumerKind::Null;
    std::string pipe_out;
    std::string preview_out;
    int preview_fps = 10;
    int device_index = -1;           // DeckLink OUT
    std::string display_mode = "HD1080i50";
    KeyerMode keyer = KeyerMode::FillOnly;  // VS program usually fill_only
    std::string stream_url;

    int vs_input_device = -1;        // DeckLink IN (-1 = file/stub)
    std::string cam_file;
    std::string bg_file;
    std::string ndi_source;

    // Chroma
    std::string key_color = "green";  // green|blue
    float similarity = 0.35f;
    float smoothness = 0.08f;
    float spill = 0.4f;

    bool passthrough = false;  // skip key: BG only (NDI latency baseline)

    bool Parse(int argc, char** argv);
    std::string Describe() const;
};

}  // namespace vs
}  // namespace bg

#endif
