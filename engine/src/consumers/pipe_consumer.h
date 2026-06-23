// engine/src/consumers/pipe_consumer.h
//
// Pipe consumer — writes raw BGRA frames to a file or stdout for debug
// (DEVELOPMENT_PROMPT §9.6).
//
// Verify with ffplay:
//   bg_engine --consumer=pipe --out=/tmp/out.bgra --duration=10 --fps=50
//   ffplay -f rawvideo -pixel_format bgra -video_size 1920x1080 -framerate 50 /tmp/out.bgra
//
// This consumer is for debugging/inspection only; it writes every frame
// sequentially (no scheduled pacing) and is not the broadcast path.

#ifndef BG_ENGINE_CONSUMERS_PIPE_CONSUMER_H
#define BG_ENGINE_CONSUMERS_PIPE_CONSUMER_H

#include "consumers/consumer.h"

#include <cstdio>
#include <cstdlib>
#include <string>

namespace bg {

class PipeConsumer final : public Consumer {
  public:
    // out_path empty -> stdout (fd 1).
    explicit PipeConsumer(std::string out_path) : out_path_(std::move(out_path)) {}

    bool Start(int width, int height, int /*fps*/) override {
        if (out_path_.empty()) {
            fp_ = stdout;
            owns_fp_ = false;
        } else {
            fp_ = std::fopen(out_path_.c_str(), "wb");
            if (!fp_) {
                std::fprintf(stderr, "bg_engine[pipe]: cannot open %s\n", out_path_.c_str());
                return false;
            }
            owns_fp_ = true;
        }
        width_ = width;
        height_ = height;
        return true;
    }

    void OnFrame(const Frame& frame) override {
        if (!fp_) return;
        // Only PET_VIEW frames of the full channel size; ignore any unexpected
        // sub-geometry (CasparCG also bounds its consumer input to the channel).
        if (frame.width != width_ || frame.height != height_) return;
        const size_t bytes = static_cast<size_t>(frame.width) * static_cast<size_t>(frame.height) * 4;
        // Best-effort: if the write would block (e.g. pipe full) we drop rather
        // than stall the render thread. stdout pipe + slow reader -> partial.
        std::fwrite(frame.bgra, 1, bytes, fp_);
    }

    void Stop() override {
        if (owns_fp_ && fp_) {
            std::fflush(fp_);
            std::fclose(fp_);
        }
        fp_ = nullptr;
    }

    const char* Label() const override { return "pipe"; }

  private:
    std::string out_path_;
    std::FILE*  fp_       = nullptr;
    bool        owns_fp_  = false;
    int         width_    = 0;
    int         height_   = 0;
};

}  // namespace bg

#endif  // BG_ENGINE_CONSUMERS_PIPE_CONSUMER_H
