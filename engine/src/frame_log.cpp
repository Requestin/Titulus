// engine/src/frame_log.cpp — see frame_log.h.

#include "frame_log.h"

namespace bg {

namespace {
constexpr size_t kFlushBytes = 64 * 1024;
constexpr auto kFlushInterval = std::chrono::seconds(1);

uint64_t ToMicroseconds(std::chrono::steady_clock::time_point time) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            time.time_since_epoch()).count());
}

uint64_t ToMicroseconds(std::chrono::system_clock::time_point time) {
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            time.time_since_epoch()).count());
}
}  // namespace

FrameLogClockSample CaptureFrameLogClocks() {
    return {
        .unix_us = ToMicroseconds(std::chrono::system_clock::now()),
        .mono_us = ToMicroseconds(std::chrono::steady_clock::now()),
    };
}

std::string_view FrameDeliveryKindName(FrameDeliveryKind kind) noexcept {
    switch (kind) {
        case FrameDeliveryKind::None: return "none";
        case FrameDeliveryKind::CefForward: return "cef_forward";
        case FrameDeliveryKind::LiveCompose: return "live_compose";
        case FrameDeliveryKind::CacheCompose: return "cache_compose";
        case FrameDeliveryKind::Reuse: return "reuse";
    }
    return "unknown";
}

std::string_view FrameWaitExitReasonName(FrameWaitExitReason reason) noexcept {
    switch (reason) {
        case FrameWaitExitReason::NoRequest: return "no_request";
        case FrameWaitExitReason::LegacyPublish: return "legacy_publish";
        case FrameWaitExitReason::CefPaint: return "cef_paint";
        case FrameWaitExitReason::Timeout: return "timeout";
    }
    return "unknown";
}

FrameLog::FrameLog(const std::string& path) {
    if (path.empty()) return;
    file_ = std::fopen(path.c_str(), "w");
    if (!file_) return;
    std::fputs(
        "schema_version,unix_us,mono_us,interval_us,begin_frame_token,"
        "cef_seq_at_send,publish_seq_at_send,wait_exit_reason,batch_id,"
        "batch_index,batch_size,cef_paint_before,cef_paint_after,"
        "publish_seq_before,publish_seq_after,delivery_kind,pump_active_us,"
        "paint_latency_us,deadline_miss,inflight_depth,paint_seq_delta,"
        "runtime_event_seq,runtime_event_age_us,"
        "raf_seq,raf_delta_us,ticks_per_raf,logical_frame_before,"
        "logical_frame_after,graph_rev,state_rev,compose_seq,"
        "live_update_generation\n",
        file_);
    buffer_.reserve(kFlushBytes + 256);
    last_flush_ = std::chrono::steady_clock::now();
}

FrameLog::~FrameLog() {
    if (!file_) return;
    Flush_();
    std::fclose(file_);
}

void FrameLog::RecordTick(const FrameLogRecord& record) {
    if (!file_) return;
    char line[768];
    const int n = std::snprintf(
        line, sizeof(line),
        "3,%llu,%llu,%llu,%llu,%llu,%llu,%.*s,%llu,%u,%u,%llu,%llu,%llu,%llu,%.*s,"
        "%llu,%llu,%d,%u,%u,%llu,%llu,%llu,%llu,%u,%llu,%llu,%llu,%llu,%llu,%llu\n",
        static_cast<unsigned long long>(record.unix_us),
        static_cast<unsigned long long>(record.mono_us),
        static_cast<unsigned long long>(record.interval_us),
        static_cast<unsigned long long>(record.begin_frame_token),
        static_cast<unsigned long long>(record.cef_seq_at_send),
        static_cast<unsigned long long>(record.publish_seq_at_send),
        static_cast<int>(FrameWaitExitReasonName(record.wait_exit_reason).size()),
        FrameWaitExitReasonName(record.wait_exit_reason).data(),
        static_cast<unsigned long long>(record.batch_id),
        record.batch_index,
        record.batch_size,
        static_cast<unsigned long long>(record.cef_paint_before),
        static_cast<unsigned long long>(record.cef_paint_after),
        static_cast<unsigned long long>(record.publish_seq_before),
        static_cast<unsigned long long>(record.publish_seq_after),
        static_cast<int>(FrameDeliveryKindName(record.delivery_kind).size()),
        FrameDeliveryKindName(record.delivery_kind).data(),
        static_cast<unsigned long long>(record.pump_active_us),
        static_cast<unsigned long long>(record.paint_latency_us),
        record.deadline_miss ? 1 : 0,
        record.inflight_depth,
        record.paint_seq_delta,
        static_cast<unsigned long long>(record.runtime_event_seq),
        static_cast<unsigned long long>(record.runtime_event_age_us),
        static_cast<unsigned long long>(record.raf_seq),
        static_cast<unsigned long long>(record.raf_delta_us),
        record.ticks_per_raf,
        static_cast<unsigned long long>(record.logical_frame_before),
        static_cast<unsigned long long>(record.logical_frame_after),
        static_cast<unsigned long long>(record.graph_rev),
        static_cast<unsigned long long>(record.state_rev),
        static_cast<unsigned long long>(record.compose_seq),
        static_cast<unsigned long long>(record.live_update_generation));
    if (n > 0 && static_cast<size_t>(n) < sizeof(line)) {
        buffer_.append(line, static_cast<size_t>(n));
    }

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
