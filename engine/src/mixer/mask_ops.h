// engine/src/mixer/mask_ops.h
//
// Mask operators for the scalar mixer. Currently supports axis-aligned rect
// masks in normal and inverted modes. Future masks (ellipse, alpha matte) live
// in a later PR and are reported as unsupported through FallbackReason.

#ifndef BG_ENGINE_MIXER_MASK_OPS_H
#define BG_ENGINE_MIXER_MASK_OPS_H

#include "render_graph_types.h"

#include <cstdint>

namespace bg {

// Returns true if `mask` is a shape/mode the scalar mixer supports.
bool IsMaskSupported(const MaskOp& mask);

// Test whether a canvas pixel survives the mask.
bool PixelSurvivesMask(const MaskOp& mask, int32_t x, int32_t y);

}  // namespace bg

#endif  // BG_ENGINE_MIXER_MASK_OPS_H
