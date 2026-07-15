// engine/src/mixer/cpu_layer_mixer.cpp

#include "cpu_layer_mixer.h"

#include "affine_sampler.h"
#include "mask_ops.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace bg {

namespace {

inline uint8_t ClampU8(int v) {
    return v < 0 ? 0 : (v > 255 ? 255 : static_cast<uint8_t>(v));
}

inline void SrcOverPixel(uint8_t* dst, const uint8_t src[4],
                         uint8_t effective_alpha) {
    const int sa = (src[3] * effective_alpha + 127) / 255;
    if (sa == 0) return;
    const int da = dst[3];
    const int inv_sa = 255 - sa;
    const int out_a = sa + da * inv_sa / 255;
    if (out_a == 0) {
        std::memset(dst, 0, 4);
        return;
    }
    for (int c = 0; c < 3; ++c) {
        const int out_c =
            (src[c] * sa + dst[c] * da * inv_sa / 255 + out_a / 2) / out_a;
        dst[c] = ClampU8(out_c);
    }
    dst[3] = ClampU8(out_a);
}

}  // namespace

bool CpuLayerMixer::IsSupported(const MixInput& input) const {
    return FallbackReasons(input).empty();
}

std::vector<FallbackReason> CpuLayerMixer::FallbackReasons(
    const MixInput& input) const {
    std::vector<FallbackReason> reasons;
    for (const auto& node : input.layers) {
        const float rot = std::round(node.layout.rotation_deg * 4.0f) / 4.0f;
        if (rot != std::floor(rot)) {
            reasons.push_back(FallbackReason::FractionalRotation);
        }
        if (node.layout.scale_x <= 0.0f || node.layout.scale_y <= 0.0f) {
            reasons.push_back(FallbackReason::NonPositiveScale);
        }
        if (node.mask && !IsMaskSupported(*node.mask)) {
            reasons.push_back(FallbackReason::NonRectMaskShape);
        }
        const int64_t src_pixels =
            static_cast<int64_t>(node.buffer.width) * node.buffer.height;
        if (src_pixels <= 0
            || src_pixels > static_cast<int64_t>(64 * 1024 * 1024)) {
            reasons.push_back(FallbackReason::OversizedLayer);
        }
    }
    return reasons;
}

void CpuLayerMixer::Mix(const MixInput& input, uint8_t* dst) {
    for (const auto& node : input.layers) {
        CompositeLayer(node, input.canvas_width, input.canvas_height, dst);
    }
}

void CpuLayerMixer::CompositeLayer(const LayerNode& node, int32_t canvas_w,
                                   int32_t canvas_h, uint8_t* dst) {
    if (node.opacity <= 0.0f) return;

    const AffineMapping mapping = BuildAffineMapping(node.layout);
    if (!mapping.supported) return;

    const uint8_t opacity_u8 =
        node.opacity >= 1.0f ? 255 : ClampU8(static_cast<int>(node.opacity * 255));

    const int32_t x0 = std::max(mapping.dest_x, 0);
    const int32_t y0 = std::max(mapping.dest_y, 0);
    const int32_t x1 = std::min(mapping.dest_x + mapping.dest_w, canvas_w);
    const int32_t y1 = std::min(mapping.dest_y + mapping.dest_h, canvas_h);

    for (int32_t dy = y0; dy < y1; ++dy) {
        for (int32_t dx = x0; dx < x1; ++dx) {
            if (node.mask && !PixelSurvivesMask(*node.mask, dx, dy)) continue;

            const float local_x = static_cast<float>(dx - mapping.dest_x);
            const float local_y = static_cast<float>(dy - mapping.dest_y);
            const float sx = mapping.src_origin_x
                + mapping.a * local_x + mapping.b * local_y;
            const float sy = mapping.src_origin_y
                + mapping.c * local_x + mapping.d * local_y;
            uint8_t pixel[4];
            if (!SampleNearest(node.buffer, sx, sy, pixel)) continue;
            SrcOverPixel(&dst[(dy * canvas_w + dx) * 4], pixel, opacity_u8);
        }
    }
}

}  // namespace bg
