#ifndef BG_ENGINE_FIELD_GRID_SCHEDULE_H
#define BG_ENGINE_FIELD_GRID_SCHEDULE_H

#include <cstdint>

namespace bg {

// Pure schedule for the development-only DeckLink field-grid experiment.
// A DeckLink completion normally requests two 1080i50 render poses. The
// treatment deliberately puts their BeginFrames on separate physical field
// slots instead of issuing the second one as soon as the first paint arrives.
struct FieldGridSlotInput {
    uint32_t batch_index = 0;
    int64_t field_period_us = 0;
};

struct FieldGridSlot {
    int64_t target_offset_us = 0;
    int64_t deadline_offset_us = 0;
};

constexpr FieldGridSlot PlanFieldGridSlot(FieldGridSlotInput input) noexcept {
    const int64_t index = static_cast<int64_t>(input.batch_index);
    const int64_t target = index * input.field_period_us;
    return {
        .target_offset_us = target,
        .deadline_offset_us = target + input.field_period_us,
    };
}

// Never postpone a late hardware-clock batch further: the caller starts its
// work immediately and records the lateness. This is the fail-open contract.
constexpr int64_t FieldGridDelayUs(FieldGridSlot slot, int64_t elapsed_us) noexcept {
    return elapsed_us < slot.target_offset_us ? slot.target_offset_us - elapsed_us : 0;
}

constexpr int64_t FieldGridLatenessUs(FieldGridSlot slot, int64_t elapsed_us) noexcept {
    return elapsed_us > slot.target_offset_us ? elapsed_us - slot.target_offset_us : 0;
}

}  // namespace bg

#endif  // BG_ENGINE_FIELD_GRID_SCHEDULE_H
