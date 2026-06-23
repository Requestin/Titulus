// engine/src/stats.cpp — see stats.h.

#include "stats.h"

#include <algorithm>
#include <cstdio>
#include <utility>

namespace bg {

void Stats::RecordFrame(uint64_t interval_us, uint64_t expected_us) {
    ++frames_;
    if (interval_us == 0) return;  // first frame: no interval yet

    if (!samples_) samples_ = std::make_unique<uint64_t[]>(kMaxSamples);
    if (sample_count_ < kMaxSamples) {
        samples_[sample_count_++] = interval_us;
    } else {
        // Reservoir-style: replace a deterministic slot so the sample keeps
        // covering the full run (good enough for percentile reporting on long
        // soaks; the median of a 65k window is stable).
        samples_[frames_ % kMaxSamples] = interval_us;
    }
    sorted_ = false;

    sum_us_ += static_cast<double>(interval_us);
    if (interval_us < min_us_) min_us_ = interval_us;
    if (interval_us > max_us_) max_us_ = interval_us;

    // A frame is "late" if it arrived >1.5x the expected interval
    // (DEVELOPMENT_PROMPT §9.7: deadline misses).
    if (expected_us > 0 && interval_us > (expected_us + expected_us / 2)) {
        ++late_;
    }
}

double Stats::drop_pct() const {
    if (frames_ == 0) return 0.0;
    return 100.0 * static_cast<double>(late_) / static_cast<double>(frames_);
}

void Stats::sort_intervals_() const {
    if (sorted_ || sample_count_ == 0) {
        sorted_ = true;
        return;
    }
    if (!sorted_cache_ || sample_count_ > kMaxSamples) {
        sorted_cache_ = std::make_unique<uint64_t[]>(sample_count_);
    }
    std::copy(samples_.get(), samples_.get() + sample_count_, sorted_cache_.get());
    std::sort(sorted_cache_.get(), sorted_cache_.get() + sample_count_);
    sorted_ = true;
}

// Returns the percentile (0..100) value from the sorted sample buffer.
namespace {
uint64_t percentile_of(const uint64_t* sorted, size_t n, double pct) {
    if (n == 0) return 0;
    // Nearest-rank percentile.
    size_t idx = static_cast<size_t>(static_cast<double>(n - 1) * (pct / 100.0));
    return sorted[idx];
}
}  // namespace

std::string Stats::Progress() const {
    if (frames_ == 0) return "frames=0";
    double avg = sum_us_ / static_cast<double>(sample_count_ > 0 ? sample_count_ : 1);
    char buf[160];
    std::snprintf(buf, sizeof(buf),
                  "frames=%llu avg_us=%.0f min_us=%llu max_us=%llu late=%llu drops=%.3f%%",
                  static_cast<unsigned long long>(frames_),
                  avg,
                  static_cast<unsigned long long>(min_us_),
                  static_cast<unsigned long long>(max_us_),
                  static_cast<unsigned long long>(late_),
                  drop_pct());
    return buf;
}

std::string Stats::Summary() const {
    sort_intervals_();
    const uint64_t p50 = percentile_of(sorted_cache_.get(), sample_count_, 50.0);
    const uint64_t p99 = percentile_of(sorted_cache_.get(), sample_count_, 99.0);
    const uint64_t p999 = percentile_of(sorted_cache_.get(), sample_count_, 99.9);

    // Effective fps from the average interval across recorded samples.
    double fps = 0.0;
    if (sample_count_ > 0) {
        double avg_us = sum_us_ / static_cast<double>(sample_count_);
        if (avg_us > 0.0) fps = 1.0e6 / avg_us;
    }

    // IMPORTANT: the SUMMARY prefix and key=value pairs are parsed by
    // bench/run-bench.sh — keep the format stable.
    char buf[256];
    std::snprintf(buf, sizeof(buf),
                  "SUMMARY frames=%llu fps=%.2f interval_p50_us=%llu interval_p99_us=%llu "
                  "interval_p999_us=%llu late=%llu drops=%.3f%%",
                  static_cast<unsigned long long>(frames_),
                  fps,
                  static_cast<unsigned long long>(p50),
                  static_cast<unsigned long long>(p99),
                  static_cast<unsigned long long>(p999),
                  static_cast<unsigned long long>(late_),
                  drop_pct());
    return buf;
}

}  // namespace bg
