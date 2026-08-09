// engine/src/decklink_event_log.cpp — see decklink_event_log.h.

#include "decklink_event_log.h"

#include <chrono>
#include <string_view>

namespace bg {
namespace {

const char* EventTypeName(DecklinkEventType type) {
    switch (type) {
        case DecklinkEventType::Schedule: return "schedule";
        case DecklinkEventType::Completion: return "completion";
        case DecklinkEventType::InputOverwrite: return "input_overwrite";
        case DecklinkEventType::ReferenceChange: return "reference_change";
    }
    return "unknown";
}

const char* WeaveModeName(WeaveProvenanceMode mode) {
    switch (mode) {
        case WeaveProvenanceMode::Pair: return "pair";
        case WeaveProvenanceMode::Single: return "single";
        case WeaveProvenanceMode::Starved: return "starved";
    }
    return "unknown";
}
}  // namespace

DecklinkEventLog::DecklinkEventLog(const std::string& path) {
    if (path.empty()) return;
    file_ = std::fopen(path.c_str(), "w");
    if (!file_) return;
    std::fputs(
        "schema_version,event,schedule_seq,unix_us,mono_us,display_time,time_scale,"
        "queue_depth_before,fresh_count,popped_a,popped_b,woven_a,woven_b,"
        "weave_mode,result,reference_state\n",
        file_);
    running_.store(true, std::memory_order_release);
    writer_ = std::thread(&DecklinkEventLog::WriterMain, this);
}

DecklinkEventLog::~DecklinkEventLog() {
    if (!file_) return;
    running_.store(false, std::memory_order_release);
    wake_cv_.notify_one();
    if (writer_.joinable()) writer_.join();
    Flush();
    std::fclose(file_);
}

bool DecklinkEventLog::TryPush(const DecklinkEvent& event) noexcept {
    if (!file_) return false;
    if (producer_lock_.test_and_set(std::memory_order_acquire)) {
        overflow_count_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }
    const size_t write = write_index_.load(std::memory_order_relaxed);
    const size_t next = (write + 1) % kCapacity;
    if (next == read_index_.load(std::memory_order_acquire)) {
        overflow_count_.fetch_add(1, std::memory_order_relaxed);
        producer_lock_.clear(std::memory_order_release);
        return false;
    }
    ring_[write] = event;
    write_index_.store(next, std::memory_order_release);
    producer_lock_.clear(std::memory_order_release);
    wake_cv_.notify_one();
    return true;
}

bool DecklinkEventLog::Pop(DecklinkEvent* event) noexcept {
    if (!event) return false;
    const size_t read = read_index_.load(std::memory_order_relaxed);
    if (read == write_index_.load(std::memory_order_acquire)) return false;
    *event = ring_[read];
    read_index_.store((read + 1) % kCapacity, std::memory_order_release);
    return true;
}

void DecklinkEventLog::WriterMain() {
    while (running_.load(std::memory_order_acquire)
           || read_index_.load(std::memory_order_acquire)
               != write_index_.load(std::memory_order_acquire)) {
        DecklinkEvent event;
        if (Pop(&event)) {
            Write(event);
            continue;
        }
        std::unique_lock<std::mutex> lock(wake_mu_);
        wake_cv_.wait_for(lock, std::chrono::milliseconds(25));
    }
}

void DecklinkEventLog::Write(const DecklinkEvent& event) {
    std::fprintf(
        file_, "1,%s,%llu,%llu,%llu,%lld,%lld,%u,%u,%llu,%llu,%llu,%llu,%s,%d,%d\n",
        EventTypeName(event.type),
        static_cast<unsigned long long>(event.schedule_seq),
        static_cast<unsigned long long>(event.unix_us),
        static_cast<unsigned long long>(event.mono_us),
        static_cast<long long>(event.display_time),
        static_cast<long long>(event.time_scale),
        event.queue_depth_before,
        event.fresh_count,
        static_cast<unsigned long long>(event.popped.field_a_seq),
        static_cast<unsigned long long>(event.popped.field_b_seq),
        static_cast<unsigned long long>(event.woven.field_a_seq),
        static_cast<unsigned long long>(event.woven.field_b_seq),
        WeaveModeName(event.weave_mode),
        event.result,
        event.reference_state);
}

void DecklinkEventLog::Flush() {
    if (file_) std::fflush(file_);
}

}  // namespace bg
