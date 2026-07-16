#ifndef BG_ENGINE_MIXER_SIMD_BLEND_H
#define BG_ENGINE_MIXER_SIMD_BLEND_H

#include <cstddef>
#include <cstdint>

namespace bg {

// Pixel-exact premultiplied BGRA8 src-over for one contiguous scanline span.
// Uses AVX2 when available at runtime and scalar tails/fallback otherwise.
void SrcOverSpan(uint8_t* dst, const uint8_t* src, size_t pixel_count,
                 uint8_t opacity);

// AVX2 nearest-neighbour affine gather + premultiplied src-over for one
// contiguous destination span. Returns false when SIMD is unavailable.
bool AffineSrcOverSpan(uint8_t* dst, const uint8_t* src,
                       int32_t source_width, int32_t source_height,
                       int32_t source_stride, float source_x,
                       float source_y, float step_x, float step_y,
                       size_t pixel_count, uint8_t opacity);

}  // namespace bg

#endif  // BG_ENGINE_MIXER_SIMD_BLEND_H
