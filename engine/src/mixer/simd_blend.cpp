#include "simd_blend.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#if defined(__x86_64__) || defined(__i386__)
#include <immintrin.h>
#endif

namespace bg {

namespace {

uint8_t MulDiv255(uint16_t value) {
    const uint16_t t = static_cast<uint16_t>(value + 128);
    return static_cast<uint8_t>((t + (t >> 8)) >> 8);
}

void SrcOverPixel(uint8_t* dst, const uint8_t* src, uint8_t opacity) {
    const uint8_t src_a = MulDiv255(
        static_cast<uint16_t>(src[3]) * opacity);
    if (src_a == 0) return;
    if (src_a == 255 && opacity == 255) {
        std::memcpy(dst, src, 4);
        return;
    }
    const uint8_t inv_a = static_cast<uint8_t>(255 - src_a);
    for (int channel = 0; channel < 3; ++channel) {
        const uint8_t src_c = MulDiv255(
            static_cast<uint16_t>(src[channel]) * opacity);
        const uint8_t dst_c = MulDiv255(
            static_cast<uint16_t>(dst[channel]) * inv_a);
        dst[channel] = static_cast<uint8_t>(
            std::min(255, static_cast<int>(src_c) + dst_c));
    }
    dst[3] = static_cast<uint8_t>(
        std::min(255, static_cast<int>(src_a)
            + MulDiv255(static_cast<uint16_t>(dst[3]) * inv_a)));
}

#if (defined(__GNUC__) || defined(__clang__)) \
    && (defined(__x86_64__) || defined(__i386__))

__attribute__((target("avx2")))
__m256i MulDiv255x16(__m256i value) {
    const __m256i bias = _mm256_set1_epi16(128);
    const __m256i t = _mm256_add_epi16(value, bias);
    return _mm256_srli_epi16(
        _mm256_add_epi16(t, _mm256_srli_epi16(t, 8)), 8);
}

__attribute__((target("avx2")))
__m256i BlendEight(
    __m256i dst8, __m256i src8, __m256i opacity16, uint8_t opacity) {
    if (opacity == 255) {
        const __m256i alpha32 = _mm256_srli_epi32(src8, 24);
        const __m256i opaque = _mm256_cmpeq_epi32(
            alpha32, _mm256_set1_epi32(255));
        if (_mm256_movemask_epi8(opaque) == -1) return src8;
        const __m256i transparent = _mm256_cmpeq_epi32(
            alpha32, _mm256_setzero_si256());
        if (_mm256_movemask_epi8(transparent) == -1) return dst8;
    }
    const __m256i zero = _mm256_setzero_si256();
    const __m256i full16 = _mm256_set1_epi16(255);
    const __m256i alpha_shuffle = _mm256_setr_epi8(
        3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15,
        3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15);
    const __m256i alpha8 = _mm256_shuffle_epi8(src8, alpha_shuffle);
    const __m256i src_lo = _mm256_unpacklo_epi8(src8, zero);
    const __m256i src_hi = _mm256_unpackhi_epi8(src8, zero);
    const __m256i dst_lo = _mm256_unpacklo_epi8(dst8, zero);
    const __m256i dst_hi = _mm256_unpackhi_epi8(dst8, zero);
    const __m256i alpha_lo = _mm256_unpacklo_epi8(alpha8, zero);
    const __m256i alpha_hi = _mm256_unpackhi_epi8(alpha8, zero);

    const __m256i effective_src_lo = MulDiv255x16(
        _mm256_mullo_epi16(src_lo, opacity16));
    const __m256i effective_src_hi = MulDiv255x16(
        _mm256_mullo_epi16(src_hi, opacity16));
    const __m256i effective_alpha_lo = MulDiv255x16(
        _mm256_mullo_epi16(alpha_lo, opacity16));
    const __m256i effective_alpha_hi = MulDiv255x16(
        _mm256_mullo_epi16(alpha_hi, opacity16));
    const __m256i inv_alpha_lo =
        _mm256_sub_epi16(full16, effective_alpha_lo);
    const __m256i inv_alpha_hi =
        _mm256_sub_epi16(full16, effective_alpha_hi);

    const __m256i out_lo = _mm256_add_epi16(
        effective_src_lo,
        MulDiv255x16(_mm256_mullo_epi16(dst_lo, inv_alpha_lo)));
    const __m256i out_hi = _mm256_add_epi16(
        effective_src_hi,
        MulDiv255x16(_mm256_mullo_epi16(dst_hi, inv_alpha_hi)));
    return _mm256_packus_epi16(out_lo, out_hi);
}

__attribute__((target("avx2")))
void SrcOverAvx2(uint8_t* dst, const uint8_t* src, size_t pixel_count,
                 uint8_t opacity) {
    const __m256i opacity16 = _mm256_set1_epi16(opacity);

    size_t pixel = 0;
    for (; pixel + 8 <= pixel_count; pixel += 8) {
        const __m256i src8 = _mm256_loadu_si256(
            reinterpret_cast<const __m256i*>(src + pixel * 4));
        const __m256i dst8 = _mm256_loadu_si256(
            reinterpret_cast<const __m256i*>(dst + pixel * 4));
        const __m256i packed = BlendEight(dst8, src8, opacity16, opacity);
        _mm256_storeu_si256(
            reinterpret_cast<__m256i*>(dst + pixel * 4), packed);
    }
    for (; pixel < pixel_count; ++pixel) {
        SrcOverPixel(dst + pixel * 4, src + pixel * 4, opacity);
    }
}

__attribute__((target("avx2")))
void AffineSrcOverAvx2(
    uint8_t* dst, const uint8_t* src, int32_t source_width,
    int32_t source_height, int32_t source_stride, float source_x,
    float source_y, float step_x, float step_y, size_t pixel_count,
    uint8_t opacity) {
    const __m256 lane = _mm256_setr_ps(
        0.0f, 1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f);
    const __m256 step_x8 = _mm256_set1_ps(step_x);
    const __m256 step_y8 = _mm256_set1_ps(step_y);
    const __m256i negative_one = _mm256_set1_epi32(-1);
    const __m256i width = _mm256_set1_epi32(source_width);
    const __m256i height = _mm256_set1_epi32(source_height);
    const __m256i stride = _mm256_set1_epi32(source_stride);
    const __m256i four = _mm256_set1_epi32(4);
    const __m256i opacity16 = _mm256_set1_epi16(opacity);
    const __m256i zero = _mm256_setzero_si256();

    size_t pixel = 0;
    for (; pixel + 8 <= pixel_count; pixel += 8) {
        const float offset = static_cast<float>(pixel);
        const __m256 sx = _mm256_add_ps(
            _mm256_set1_ps(source_x + offset * step_x),
            _mm256_mul_ps(lane, step_x8));
        const __m256 sy = _mm256_add_ps(
            _mm256_set1_ps(source_y + offset * step_y),
            _mm256_mul_ps(lane, step_y8));
        const __m256i ix = _mm256_cvttps_epi32(_mm256_floor_ps(sx));
        const __m256i iy = _mm256_cvttps_epi32(_mm256_floor_ps(sy));
        const __m256i valid_x = _mm256_and_si256(
            _mm256_cmpgt_epi32(ix, negative_one),
            _mm256_cmpgt_epi32(width, ix));
        const __m256i valid_y = _mm256_and_si256(
            _mm256_cmpgt_epi32(iy, negative_one),
            _mm256_cmpgt_epi32(height, iy));
        const __m256i valid = _mm256_and_si256(valid_x, valid_y);
        const __m256i offsets = _mm256_add_epi32(
            _mm256_mullo_epi32(iy, stride),
            _mm256_mullo_epi32(ix, four));
        const __m256i gathered = _mm256_mask_i32gather_epi32(
            zero, reinterpret_cast<const int*>(src), offsets, valid, 1);
        const __m256i destination = _mm256_loadu_si256(
            reinterpret_cast<const __m256i*>(dst + pixel * 4));
        _mm256_storeu_si256(
            reinterpret_cast<__m256i*>(dst + pixel * 4),
            BlendEight(destination, gathered, opacity16, opacity));
    }
    for (; pixel < pixel_count; ++pixel) {
        const int32_t ix = static_cast<int32_t>(
            std::floor(source_x + static_cast<float>(pixel) * step_x));
        const int32_t iy = static_cast<int32_t>(
            std::floor(source_y + static_cast<float>(pixel) * step_y));
        if (ix < 0 || iy < 0 || ix >= source_width || iy >= source_height) {
            continue;
        }
        SrcOverPixel(
            dst + pixel * 4,
            src + static_cast<int64_t>(iy) * source_stride + ix * 4,
            opacity);
    }
}

bool HasAvx2() {
    static const bool available = [] {
        __builtin_cpu_init();
        return __builtin_cpu_supports("avx2");
    }();
    return available;
}

#endif

}  // namespace

void SrcOverSpan(uint8_t* dst, const uint8_t* src, size_t pixel_count,
                 uint8_t opacity) {
    if (!dst || !src || pixel_count == 0 || opacity == 0) return;
#if (defined(__GNUC__) || defined(__clang__)) \
    && (defined(__x86_64__) || defined(__i386__))
    if (HasAvx2() && pixel_count >= 8) {
        SrcOverAvx2(dst, src, pixel_count, opacity);
        return;
    }
#endif
    for (size_t pixel = 0; pixel < pixel_count; ++pixel) {
        SrcOverPixel(dst + pixel * 4, src + pixel * 4, opacity);
    }
}

bool AffineSrcOverSpan(
    uint8_t* dst, const uint8_t* src, int32_t source_width,
    int32_t source_height, int32_t source_stride, float source_x,
    float source_y, float step_x, float step_y, size_t pixel_count,
    uint8_t opacity) {
    if (!dst || !src || pixel_count == 0 || opacity == 0) return true;
#if (defined(__GNUC__) || defined(__clang__)) \
    && (defined(__x86_64__) || defined(__i386__))
    if (HasAvx2()) {
        AffineSrcOverAvx2(
            dst, src, source_width, source_height, source_stride, source_x,
            source_y, step_x, step_y, pixel_count, opacity);
        return true;
    }
#endif
    return false;
}

}  // namespace bg
