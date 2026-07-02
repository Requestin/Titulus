// engine/src/stats.h
//
// Per-engine frame statistics (DEVELOPMENT_PROMPT §9.7, NFR-2).
//
// Tracks the cadence of OnPaint deliveries and reports:
//   - effective fps
//   - inter-frame interval percentiles (p50/p99/p999)
//   - late frame count (>1.5x expected interval) and drop percentage
//
// Emits a SUMMARY line at shutdown for the bench harness to parse
// (DEVELOPMENT_PROMPT §11.1, bench/run-bench.sh).

#ifndef BG_ENGINE_STATS_H
#define BG_ENGINE_STATS_H

#include <cstdint>
#include <cstddef>
#include <memory>
#include <string>

namespace bg {

class Stats {
  public:
    Stats() = default;

    // Record the arrival of one frame. interval_us is microseconds since the
    // previous frame (0 for the very first). expected_us is the target frame
    // interval (e.g. 20000 for 50fps).
    void RecordFrame(uint64_t interval_us, uint64_t expected_us);

    // Emit a single SUMMARY line with fps/percentiles/late/drops, suitable for
    // the bench harness to parse.
    std::string Summary() const;

    // Emit a periodic progress line for logging at the given stats interval.
    std::string Progress() const;

    uint64_t frames()     const { return frames_; }
    uint64_t late()       const { return late_; }
    double    drop_pct()  const;

  private:
    void sort_intervals_() const;

    uint64_t frames_     = 0;
    uint64_t late_       = 0;   // interval > 1.5x expected
    uint64_t min_us_     = ~0ULL;
    uint64_t max_us_     = 0;
    double   sum_us_     = 0.0;

    // Rolling window since the previous Progress() call. The cumulative avg
    // hides the *current* state on long runs (one 10s stall poisons avg_us
    // forever), so Progress() also reports a per-interval window fps/late.
    mutable uint64_t win_frames_ = 0;
    mutable uint64_t win_late_   = 0;
    mutable double   win_sum_us_ = 0.0;

    // Ring buffer of recent intervals for percentile reporting (cap memory; we
    // only need a representative sample for p50/p99/p999).
    static constexpr size_t kMaxSamples = 1u << 16;  // 65536 samples (~22 min @50fps)
    std::unique_ptr<uint64_t[]> samples_;
    size_t   sample_count_ = 0;
    mutable bool sorted_   = false;
    mutable std::unique_ptr<uint64_t[]> sorted_cache_;
};

}  // namespace bg

#endif  // BG_ENGINE_STATS_H
