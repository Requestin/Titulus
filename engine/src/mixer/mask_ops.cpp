// engine/src/mixer/mask_ops.cpp

#include "mask_ops.h"

namespace bg {

bool IsMaskSupported(const MaskOp& mask) {
    // Scalar mixer supports axis-aligned rect masks in normal/inverted modes.
    // Other shapes land in a later PR and are reported as fallback.
    return true;  // MaskOp only encodes rect + normal/inverted for now.
}

bool PixelSurvivesMask(const MaskOp& mask, int32_t x, int32_t y) {
    const bool inside = x >= mask.rect.x
        && x < mask.rect.x + mask.rect.width
        && y >= mask.rect.y
        && y < mask.rect.y + mask.rect.height;
    return mask.mode == MaskMode::Normal ? inside : !inside;
}

}  // namespace bg
