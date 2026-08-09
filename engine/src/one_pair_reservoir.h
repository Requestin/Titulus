#ifndef BG_ENGINE_ONE_PAIR_RESERVOIR_H
#define BG_ENGINE_ONE_PAIR_RESERVOIR_H

#include <cstddef>

namespace bg {

// Pure state decision for the development-only one-pair DeckLink reservoir.
// The reservoir owns at most the two unique progressive poses required for
// one interlaced output container. A late producer never extends the wait:
// underflow returns control to the existing single/starved fail-open policy.
enum class OnePairReservoirDecision {
    Bypass,
    Wait,
    Ready,
    Underflow,
};

struct OnePairReservoirInput {
    bool enabled = false;
    size_t queued_frames = 0;
    bool deadline_reached = false;
};

constexpr OnePairReservoirDecision DecideOnePairReservoir(
    OnePairReservoirInput input) noexcept {
    if (!input.enabled) return OnePairReservoirDecision::Bypass;
    if (input.queued_frames >= 2) return OnePairReservoirDecision::Ready;
    return input.deadline_reached
        ? OnePairReservoirDecision::Underflow
        : OnePairReservoirDecision::Wait;
}

}  // namespace bg

#endif  // BG_ENGINE_ONE_PAIR_RESERVOIR_H
