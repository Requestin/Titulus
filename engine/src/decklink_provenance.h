// engine/src/decklink_provenance.h
//
// SDK-independent provenance decision for one scheduled output container.

#ifndef BG_ENGINE_DECKLINK_PROVENANCE_H
#define BG_ENGINE_DECKLINK_PROVENANCE_H

#include <cstddef>
#include <cstdint>

namespace bg {

enum class WeaveProvenanceMode : uint8_t {
    Pair,
    Single,
    Starved,
};

struct WeaveProvenancePair {
    uint64_t field_a_seq = 0;
    uint64_t field_b_seq = 0;
};

struct WeaveProvenanceDecision {
    WeaveProvenanceMode mode = WeaveProvenanceMode::Starved;
    WeaveProvenancePair woven;
};

WeaveProvenanceDecision DecideWeaveProvenance(
    size_t fresh_count, uint64_t first_fresh_seq, uint64_t second_fresh_seq,
    WeaveProvenancePair previous) noexcept;

}  // namespace bg

#endif  // BG_ENGINE_DECKLINK_PROVENANCE_H
