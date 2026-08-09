// engine/src/decklink_event_log.h
//
// Opt-in, bounded event writer for DeckLink callback provenance.

#ifndef BG_ENGINE_DECKLINK_EVENT_LOG_H
#define BG_ENGINE_DECKLINK_EVENT_LOG_H

#include "decklink_provenance.h"

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>

namespace bg {

enum class DecklinkEventType : uint8_t {
    Schedule,
    Completion,
    InputOverwrite,
    ReservoirUnderflow,
    ReferenceChange,
};

struct DecklinkEvent {
    DecklinkEventType type = DecklinkEventType::Schedule;
    uint64_t schedule_seq = 0;
    uint64_t unix_us = 0;
    uint64_t mono_us = 0;
    int64_t display_time = 0;
    int64_t time_scale = 0;
    uint32_t queue_depth_before = 0;
    uint32_t fresh_count = 0;
    WeaveProvenancePair popped;
    WeaveProvenancePair woven;
    WeaveProvenanceMode weave_mode = WeaveProvenanceMode::Starved;
    int32_t result = 0;
    int32_t reference_state = 0;
};

class DecklinkEventLog {
  public:
    explicit DecklinkEventLog(const std::string& path);
    ~DecklinkEventLog();

    DecklinkEventLog(const DecklinkEventLog&) = delete;
    DecklinkEventLog& operator=(const DecklinkEventLog&) = delete;

    bool enabled() const noexcept { return file_ != nullptr; }
    bool TryPush(const DecklinkEvent& event) noexcept;
    uint64_t overflow_count() const noexcept {
        return overflow_count_.load(std::memory_order_relaxed);
    }

  private:
    static constexpr size_t kCapacity = 1024;

    void WriterMain();
    bool Pop(DecklinkEvent* event) noexcept;
    void Write(const DecklinkEvent& event);
    void Flush();

    std::FILE* file_ = nullptr;
    std::array<DecklinkEvent, kCapacity> ring_{};
    // DeckLink does not promise that completion callbacks are serialized.
    // Producers never wait: a concurrent producer drops its event explicitly.
    std::atomic_flag producer_lock_ = ATOMIC_FLAG_INIT;
    std::atomic<size_t> write_index_{0};
    std::atomic<size_t> read_index_{0};
    std::atomic<uint64_t> overflow_count_{0};
    std::atomic<bool> running_{false};
    std::mutex wake_mu_;
    std::condition_variable wake_cv_;
    std::thread writer_;
};

}  // namespace bg

#endif  // BG_ENGINE_DECKLINK_EVENT_LOG_H
