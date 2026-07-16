// engine/src/mixer/mask_ops.cpp

#include "mask_ops.h"

#include <cstdint>

namespace bg {

bool IsMaskSupported(const MaskOp& mask) {
    // Scalar mixer supports axis-aligned rect masks in normal/inverted modes.
    // Other shapes land in a later PR and are reported as fallback.
    return true;  // MaskOp only encodes rect + normal/inverted for now.
}

bool PixelSurvivesMask(const MaskOp& mask, int32_t x, int32_t y) {
    const int64_t right =
        static_cast<int64_t>(mask.rect.x) + mask.rect.width;
    const int64_t bottom =
        static_cast<int64_t>(mask.rect.y) + mask.rect.height;
    const bool inside = mask.rect.width > 0 && mask.rect.height > 0
        && static_cast<int64_t>(x) >= mask.rect.x
        && static_cast<int64_t>(x) < right
        && static_cast<int64_t>(y) >= mask.rect.y
        && static_cast<int64_t>(y) < bottom;
    return mask.mode == MaskMode::Normal ? inside : !inside;
}

}  // namespace bg
