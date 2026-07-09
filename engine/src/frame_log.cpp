// engine/src/frame_log.cpp — see frame_log.h.

#include "frame_log.h"

namespace bg {

namespace {
constexpr size_t kFlushBytes = 64 * 1024;
constexpr auto kFlushInterval = std::chrono::seconds(1);
}  // namespace

FrameLog::FrameLog(const std::string& path) {
    if (path.empty()) return;
    file_ = std::fopen(path.c_str(), "w");
    if (!file_) return;
    std::fputs(
        "wall_clock_us,interval_us,paint_seq,pump_active_us,paint_latency_us,"
        "waited_deadline,inflight_depth,paint_seq_delta\n",
        file_);
    buffer_.reserve(kFlushBytes + 256);
    last_flush_ = std::chrono::steady_clock::now();
}

FrameLog::~FrameLog() {
    if (!file_) return;
    Flush_();
    std::fclose(file_);
}

void FrameLog::RecordTick(uint64_t wall_clock_us, uint64_t interval_us, uint64_t paint_seq,
                          uint64_t pump_active_us, uint64_t paint_latency_us,
                          int waited_deadline, int inflight_depth, int paint_seq_delta) {
    if (!file_) return;
    char line[192];
    const int n = std::snprintf(line, sizeof(line), "%llu,%llu,%llu,%llu,%llu,%d,%d,%d\n",
                                static_cast<unsigned long long>(wall_clock_us),
                                static_cast<unsigned long long>(interval_us),
                                static_cast<unsigned long long>(paint_seq),
                                static_cast<unsigned long long>(pump_active_us),
                                static_cast<unsigned long long>(paint_latency_us),
                                waited_deadline, inflight_depth, paint_seq_delta);
    if (n > 0) buffer_.append(line, static_cast<size_t>(n));

    const auto now = std::chrono::steady_clock::now();
    if (buffer_.size() >= kFlushBytes || now - last_flush_ >= kFlushInterval) {
        Flush_();
        last_flush_ = now;
    }
}

void FrameLog::Flush_() {
    if (!file_ || buffer_.empty()) return;
    std::fwrite(buffer_.data(), 1, buffer_.size(), file_);
    buffer_.clear();
}

}  // namespace bg
