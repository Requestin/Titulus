// engine/src/mixer/affine_sampler.cpp

#include "affine_sampler.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <numbers>

namespace bg {

namespace {

bool IsFinite(const LayerAffine& m) {
    return std::isfinite(m.m00) && std::isfinite(m.m01)
        && std::isfinite(m.m02) && std::isfinite(m.m10)
        && std::isfinite(m.m11) && std::isfinite(m.m12);
}

LayerAffine LegacyAffine(const LayerLayout& layout) {
    const float rad =
        layout.rotation_deg * std::numbers::pi_v<float> / 180.0f;
    const float cos_r = std::cos(rad);
    const float sin_r = std::sin(rad);
    const float anchor_px_x = layout.anchor_x * layout.source_w;
    const float anchor_px_y = layout.anchor_y * layout.source_h;

    LayerAffine m;
    m.m00 = cos_r * layout.scale_x;
    m.m01 = -sin_r * layout.scale_y;
    m.m10 = sin_r * layout.scale_x;
    m.m11 = cos_r * layout.scale_y;
    // Position is the untransformed source top-left. Rotate/scale around the
    // source-space anchor while keeping that pivot fixed in canvas space.
    m.m02 = layout.position_x + anchor_px_x
        - m.m00 * anchor_px_x - m.m01 * anchor_px_y;
    m.m12 = layout.position_y + anchor_px_y
        - m.m10 * anchor_px_x - m.m11 * anchor_px_y;
    return m;
}

}  // namespace

AffineMapping BuildAffineMapping(const LayerLayout& layout) {
    AffineMapping m{};
    if (layout.source_w <= 0 || layout.source_h <= 0) {
        m.supported = false;
        return m;
    }
    if (!layout.affine
        && (!std::isfinite(layout.scale_x) || !std::isfinite(layout.scale_y)
            || !std::isfinite(layout.rotation_deg)
            || !std::isfinite(layout.anchor_x)
            || !std::isfinite(layout.anchor_y)
            || layout.scale_x <= 0.0f || layout.scale_y <= 0.0f)) {
        m.supported = false;
        return m;
    }

    const LayerAffine forward = layout.affine.value_or(LegacyAffine(layout));
    if (!IsFinite(forward)) {
        m.supported = false;
        return m;
    }
    const float det = forward.m00 * forward.m11 - forward.m01 * forward.m10;
    if (!std::isfinite(det)
        || std::abs(det) <= std::numeric_limits<float>::epsilon()) {
        m.supported = false;
        return m;
    }

    const std::array<std::array<float, 2>, 4> corners{{
        {0.0f, 0.0f},
        {static_cast<float>(layout.source_w), 0.0f},
        {0.0f, static_cast<float>(layout.source_h)},
        {static_cast<float>(layout.source_w),
         static_cast<float>(layout.source_h)},
    }};
    float min_x = std::numeric_limits<float>::infinity();
    float min_y = std::numeric_limits<float>::infinity();
    float max_x = -std::numeric_limits<float>::infinity();
    float max_y = -std::numeric_limits<float>::infinity();
    for (const auto& corner : corners) {
        const float x =
            forward.m00 * corner[0] + forward.m01 * corner[1] + forward.m02;
        const float y =
            forward.m10 * corner[0] + forward.m11 * corner[1] + forward.m12;
        min_x = std::min(min_x, x);
        min_y = std::min(min_y, y);
        max_x = std::max(max_x, x);
        max_y = std::max(max_y, y);
    }
    const float floor_x = std::floor(min_x);
    const float floor_y = std::floor(min_y);
    const float ceil_x = std::ceil(max_x);
    const float ceil_y = std::ceil(max_y);
    if (floor_x < static_cast<float>(std::numeric_limits<int32_t>::min())
        || floor_y < static_cast<float>(std::numeric_limits<int32_t>::min())
        || ceil_x > static_cast<float>(std::numeric_limits<int32_t>::max())
        || ceil_y > static_cast<float>(std::numeric_limits<int32_t>::max())) {
        m.supported = false;
        return m;
    }
    m.dest_x = static_cast<int32_t>(floor_x);
    m.dest_y = static_cast<int32_t>(floor_y);
    m.dest_w = static_cast<int32_t>(ceil_x - floor_x);
    m.dest_h = static_cast<int32_t>(ceil_y - floor_y);
    if (m.dest_w <= 0 || m.dest_h <= 0) {
        m.supported = false;
        return m;
    }

    const float inv_det = 1.0f / det;
    m.inv00 = forward.m11 * inv_det;
    m.inv01 = -forward.m01 * inv_det;
    m.inv10 = -forward.m10 * inv_det;
    m.inv11 = forward.m00 * inv_det;
    m.inv02 = -(m.inv00 * forward.m02 + m.inv01 * forward.m12);
    m.inv12 = -(m.inv10 * forward.m02 + m.inv11 * forward.m12);
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
