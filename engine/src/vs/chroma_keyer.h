// engine/src/vs/chroma_keyer.h — CPU MVP chroma key (green/blue).
// Production GPU key: docs/GPU_GATE_unreal_vs.md

#ifndef BG_VS_CHROMA_KEYER_H
#define BG_VS_CHROMA_KEYER_H

#include <cstdint>
#include <vector>

namespace bg {
namespace vs {

struct ChromaKeyParams {
    // Key color in BGRA (default chroma green).
    uint8_t key_b = 20;
    uint8_t key_g = 180;
    uint8_t key_r = 20;
    float similarity = 0.35f;  // 0..1 distance threshold
    float smoothness = 0.08f;  // soft edge width
    float spill = 0.4f;        // despill strength 0..1
};

// In-place: writes alpha into BGRA[3]; optionally despills RGB toward neutral.
void ApplyChromaKey(uint8_t* bgra, int width, int height, const ChromaKeyParams& p);

// Out-of-place into dst (same size).
void ApplyChromaKeyTo(const uint8_t* src, uint8_t* dst, int width, int height,
                      const ChromaKeyParams& p);

}  // namespace vs
}  // namespace bg

#endif
