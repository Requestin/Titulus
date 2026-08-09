// engine/src/decklink_provenance.cpp — see decklink_provenance.h.

#include "decklink_provenance.h"

namespace bg {

WeaveProvenanceDecision DecideWeaveProvenance(
    size_t fresh_count, uint64_t first_fresh_seq, uint64_t second_fresh_seq,
    WeaveProvenancePair previous) noexcept {
    if (fresh_count >= 2) {
        return {
            .mode = WeaveProvenanceMode::Pair,
            .woven = {
                .field_a_seq = first_fresh_seq,
                .field_b_seq = second_fresh_seq,
            },
        };
    }
    if (fresh_count == 1) {
        return {
            .mode = WeaveProvenanceMode::Single,
            .woven = {
                .field_a_seq = first_fresh_seq,
                .field_b_seq = first_fresh_seq,
            },
        };
    }
    return {
        .mode = WeaveProvenanceMode::Starved,
        .woven = previous,
    };
}

}  // namespace bg
