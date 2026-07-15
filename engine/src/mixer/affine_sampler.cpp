// engine/src/mixer/affine_sampler.cpp

#include "affine_sampler.h"

#include <cmath>

namespace bg {

namespace {

bool IsSupportedLayout(const LayerLayout& layout) {
    if (layout.scale_x <= 0.0f || layout.scale_y <= 0.0f) return false;
    const float rounded = std::round(layout.rotation_deg * 4.0f) / 4.0f;
    if (rounded != std::floor(rounded)) return false;
    return true;
}

}  // namespace

AffineMapping BuildAffineMapping(const LayerLayout& layout) {
    AffineMapping m{};
    if (!IsSupportedLayout(layout)) {
        m.supported = false;
        return m;
    }
    const float deg = std::round(layout.rotation_deg);
    const float rad = deg * static_cast<float>(M_PI) / 180.0f;
    const float cos_r = std::cos(rad);
    const float sin_r = std::sin(rad);
    const float abs_cos = std::abs(cos_r);
    const float abs_sin = std::abs(sin_r);

    const float scaled_w = layout.source_w * layout.scale_x;
    const float scaled_h = layout.source_h * layout.scale_y;
    m.dest_w = static_cast<int32_t>(
        std::ceil(scaled_w * abs_cos + scaled_h * abs_sin));
    m.dest_h = static_cast<int32_t>(
        std::ceil(scaled_w * abs_sin + scaled_h * abs_cos));
    if (m.dest_w <= 0 || m.dest_h <= 0) {
        m.supported = false;
        return m;
    }
    m.dest_x = layout.position_x;
    m.dest_y = layout.position_y;

    // Inverse affine coefficients so the compositor can map a destination
    // layer-local coordinate back to source pixels: source = anchor_src +
    // R^T * scale^{-1} * (local - anchor_dest).
    m.a = cos_r / layout.scale_x;
    m.b = sin_r / layout.scale_x;
    m.c = -sin_r / layout.scale_y;
    m.d = cos_r / layout.scale_y;
    // Anchor in source vs destination coordinates.
    m.src_origin_x = layout.anchor_x * layout.source_w
        - (m.a * (layout.anchor_x * scaled_w) + m.b * (layout.anchor_y * scaled_h));
    m.src_origin_y = layout.anchor_y * layout.source_h
        - (m.c * (layout.anchor_x * scaled_w) + m.d * (layout.anchor_y * scaled_h));
    return m;
}

bool SampleNearest(const LayerBufferRef& src, float sx, float sy,
                   uint8_t out[4]) {
    const int ix = static_cast<int>(std::floor(sx));
    const int iy = static_cast<int>(std::floor(sy));
    if (ix < 0 || iy < 0 || ix >= src.width || iy >= src.height) return false;
    const int32_t stride = src.stride_bytes != 0 ? src.stride_bytes : src.width * 4;
    const uint8_t* px = src.data + iy * stride + ix * 4;
    out[0] = px[0];
    out[1] = px[1];
    out[2] = px[2];
    out[3] = px[3];
    return true;
}

}  // namespace bg
