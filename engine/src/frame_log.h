// engine/src/frame_log.h
//
// Optional per-pump-tick CSV diagnostic log. Phase 17 introduced the latency
// columns; Phase 20 adds explicit clock domains and provenance identities.
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
#include <string_view>

namespace bg {

// `mono_us` measures intervals/durations only. `unix_us` is the correlation
// key for operator marks and host traces. Never derive Unix time from
// steady_clock's unspecified epoch.
struct FrameLogClockSample {
    uint64_t unix_us = 0;
    uint64_t mono_us = 0;
};

FrameLogClockSample CaptureFrameLogClocks();

enum class FrameDeliveryKind : uint8_t {
    None,
    CefForward,
    LiveCompose,
    CacheCompose,
    Reuse,
};

std::string_view FrameDeliveryKindName(FrameDeliveryKind kind) noexcept;

// Schema v2 is intentionally wide before all producers are wired. A zero value
// means "not observed by this producer", never an inferred identity.
struct FrameLogRecord {
    uint64_t unix_us = 0;
    uint64_t mono_us = 0;
    uint64_t interval_us = 0;
    uint64_t begin_frame_token = 0;
    uint64_t batch_id = 0;
    uint32_t batch_index = 0;
    uint32_t batch_size = 0;
    uint64_t cef_paint_before = 0;
    uint64_t cef_paint_after = 0;
    uint64_t publish_seq_before = 0;
    uint64_t publish_seq_after = 0;
    FrameDeliveryKind delivery_kind = FrameDeliveryKind::None;
    uint64_t pump_active_us = 0;
    uint64_t paint_latency_us = 0;
    bool deadline_miss = false;
    uint32_t inflight_depth = 0;
    uint32_t paint_seq_delta = 0;
    uint64_t runtime_event_seq = 0;
    uint64_t runtime_event_age_us = 0;
    uint64_t raf_seq = 0;
    uint64_t raf_delta_us = 0;
    uint32_t ticks_per_raf = 0;
    uint64_t logical_frame_before = 0;
    uint64_t logical_frame_after = 0;
    uint64_t graph_rev = 0;
    uint64_t state_rev = 0;
    uint64_t compose_seq = 0;
    uint64_t live_update_generation = 0;
};

class FrameLog {
  public:
    // path.empty() => logging disabled; every method becomes a no-op.
    explicit FrameLog(const std::string& path);
    ~FrameLog();

    FrameLog(const FrameLog&) = delete;
    FrameLog& operator=(const FrameLog&) = delete;

    bool enabled() const { return file_ != nullptr; }

    // One row per pump tick, including misses. `interval_us` is zero when
    // nothing was delivered during the tick.
    void RecordTick(const FrameLogRecord& record);

  private:
    void Flush_();

    std::FILE* file_ = nullptr;
    std::string buffer_;
    std::chrono::steady_clock::time_point last_flush_{};
};

}  // namespace bg

#endif  // BG_ENGINE_FRAME_LOG_H
