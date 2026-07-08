// engine/src/frame_log.h
//
// Phase 17 P0: optional per-frame CSV diagnostic log used to tell apart a
// throughput-bound raster pool (hypothesis A) from a latency-bound
// BeginFrame->OnPaint IPC round-trip (hypothesis B) — see
// docs/development-phases/phase-17-raster-latency.md.
//
// Disabled (all methods no-op) unless --frame-log=PATH / BG_ENGINE_FRAME_LOG
// is set, so the default decklink/browser paths are untouched. When enabled,
// rows are buffered in memory and flushed roughly once a second so the log
// itself doesn't become a source of pump jitter.

#ifndef BG_ENGINE_FRAME_LOG_H
#define BG_ENGINE_FRAME_LOG_H

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>

namespace bg {

class FrameLog {
  public:
    // path.empty() => logging disabled; every method becomes a no-op.
    explicit FrameLog(const std::string& path);
    ~FrameLog();

    FrameLog(const FrameLog&) = delete;
    FrameLog& operator=(const FrameLog&) = delete;

    bool enabled() const { return file_ != nullptr; }

    // One row per pump tick (whether or not it delivered a new painted frame).
    // interval_us is 0 when no frame was delivered this tick.
    void RecordTick(uint64_t wall_clock_us, uint64_t interval_us, uint64_t paint_seq,
                    uint64_t pump_active_us, uint64_t paint_latency_us, int waited_deadline);

  private:
    void Flush_();

    std::FILE* file_ = nullptr;
    std::string buffer_;
    std::chrono::steady_clock::time_point last_flush_{};
};

}  // namespace bg

#endif  // BG_ENGINE_FRAME_LOG_H
