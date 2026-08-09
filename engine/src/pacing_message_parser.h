// engine/src/pacing_message_parser.h
//
// Bounded parser and latest-event store for P20.1 `BGPACING v1` console lines.

#ifndef BG_ENGINE_PACING_MESSAGE_PARSER_H
#define BG_ENGINE_PACING_MESSAGE_PARSER_H

#include <cstdint>
#include <string>
#include <string_view>

namespace bg {

struct RuntimePacingEvent {
    uint64_t runtime_event_seq = 0;
    uint64_t raf_seq = 0;
    uint64_t runtime_perf_us = 0;
    uint64_t runtime_unix_us = 0;
    uint64_t raf_delta_us = 0;
    uint32_t ticks_per_raf = 0;
    uint64_t logical_frame_before = 0;
    uint64_t logical_frame_after = 0;
    uint32_t active_count = 0;
    bool identity_valid = false;
    std::string template_id;
    uint64_t graph_revision = 0;
    uint64_t state_revision = 0;
};

enum class PacingParseStatus : uint8_t {
    Ok,
    NotPacingMessage,
    Malformed,
};

struct PacingParseResult {
    PacingParseStatus status = PacingParseStatus::NotPacingMessage;
    RuntimePacingEvent event;
};

PacingParseResult ParsePacingMessage(std::string_view message);

struct RuntimePacingSnapshot {
    bool present = false;
    RuntimePacingEvent event;
    uint64_t host_unix_us = 0;
    uint64_t host_mono_us = 0;
};

// EngineClient's console callback and the main pump run on the same CEF
// application thread. This intentionally stores only the latest observed
// runtime event; it is not a paint acknowledgement.
class RuntimePacingStore {
  public:
    void Commit(RuntimePacingEvent event, uint64_t host_unix_us,
                uint64_t host_mono_us);
    RuntimePacingSnapshot Snapshot() const;

  private:
    RuntimePacingSnapshot latest_;
};

}  // namespace bg

#endif  // BG_ENGINE_PACING_MESSAGE_PARSER_H
