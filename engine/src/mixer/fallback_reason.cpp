// engine/src/mixer/fallback_reason.cpp
//
// Friendly labels for FallbackReason codes. Kept out of the header so the
// mixer core has no static data dependencies.

#include "render_graph_types.h"

namespace bg {

const char* FallbackReasonLabel(FallbackReason reason) {
    switch (reason) {
        case FallbackReason::FractionalRotation:
            return "fractional_rotation";
        case FallbackReason::NonPositiveScale:
            return "non_positive_scale";
        case FallbackReason::NonRectMaskShape:
            return "non_rect_mask_shape";
        case FallbackReason::OversizedLayer:
            return "oversized_layer";
        case FallbackReason::InvalidBuffer:
            return "invalid_buffer";
        case FallbackReason::NonFiniteTransform:
            return "non_finite_transform";
        case FallbackReason::SingularTransform:
            return "singular_transform";
    }
    return "unknown";
}

}  // namespace bg
