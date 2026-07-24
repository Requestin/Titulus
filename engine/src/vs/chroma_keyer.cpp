// engine/src/vs/chroma_keyer.cpp — CPU MVP chroma keyer.

#include "vs/chroma_keyer.h"

#include <algorithm>
#include <cmath>

namespace bg {
namespace vs {

namespace {

inline float Dist2(int b, int g, int r, int kb, int kg, int kr) {
    const float db = static_cast<float>(b - kb);
    const float dg = static_cast<float>(g - kg);
    const float dr = static_cast<float>(r - kr);
    return db * db + dg * dg + dr * dr;
}

}  // namespace

void ApplyChromaKeyTo(const uint8_t* src, uint8_t* dst, int width, int height,
                      const ChromaKeyParams& p) {
    if (!src || !dst || width <= 0 || height <= 0) return;
    const float max_d = 255.f * 255.f * 3.f;
    const float sim = std::clamp(p.similarity, 0.f, 1.f);
    const float smooth = std::max(0.001f, p.smoothness);
    const float thr = sim * sim * max_d;
    const float thr2 = (sim + smooth) * (sim + smooth) * max_d;
    const float spill = std::clamp(p.spill, 0.f, 1.f);

    const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height);
    for (size_t i = 0; i < n; ++i) {
        const uint8_t* s = src + i * 4;
        uint8_t* d = dst + i * 4;
        const int b = s[0], g = s[1], r = s[2];
        const float dist = Dist2(b, g, r, p.key_b, p.key_g, p.key_r);

        float alpha = 1.f;
        if (dist <= thr) {
            alpha = 0.f;
        } else if (dist < thr2) {
            alpha = (dist - thr) / (thr2 - thr);
        }

        int ob = b, og = g, or_ = r;
        if (spill > 0.f && alpha > 0.f && alpha < 1.f) {
            // Pull keyed channel toward average of the other two.
            const int avg = (b + r) / 2;
            og = static_cast<int>(g + (avg - g) * spill * (1.f - alpha));
        }

        d[0] = static_cast<uint8_t>(std::clamp(ob, 0, 255));
        d[1] = static_cast<uint8_t>(std::clamp(og, 0, 255));
        d[2] = static_cast<uint8_t>(std::clamp(or_, 0, 255));
        d[3] = static_cast<uint8_t>(std::clamp(static_cast<int>(alpha * 255.f + 0.5f), 0, 255));
    }
}

void ApplyChromaKey(uint8_t* bgra, int width, int height, const ChromaKeyParams& p) {
    if (!bgra) return;
    // Work in-place via temp copy of alpha-only path would alias; copy to temp.
    const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
    std::vector<uint8_t> tmp(bgra, bgra + n);
    ApplyChromaKeyTo(tmp.data(), bgra, width, height, p);
}

}  // namespace vs
}  // namespace bg
