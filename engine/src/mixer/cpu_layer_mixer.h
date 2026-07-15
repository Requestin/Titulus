// engine/src/mixer/cpu_layer_mixer.h
//
// Scalar reference implementation of the Doc02 layered compositor. Walks the
// MixInput layer list back-to-front, applies per-layer masks, affine layouts
// and opacity, and writes straight-alpha src-over into a destination BGRA8
// frame.

#ifndef BG_ENGINE_MIXER_CPU_LAYER_MIXER_H
#define BG_ENGINE_MIXER_CPU_LAYER_MIXER_H

#include "render_graph_types.h"

#include <cstdint>
#include <vector>

namespace bg {

class CpuLayerMixer {
  public:
    CpuLayerMixer() = default;

    // Returns false when at least one layer uses an unsupported operator.
    // Callers must fall back to the legacy monolith rather than mixing partial
    // output.
    bool IsSupported(const MixInput& input) const;

    // Returns the per-input fallback reasons. Empty when supported.
    std::vector<FallbackReason> FallbackReasons(const MixInput& input) const;

    // Blend `input` into `dst` (BGRA8, `canvas_width * canvas_height * 4`
    // bytes). The destination is read and written; transparent source pixels
    // leave it unchanged. Input source buffers are never modified.
    void Mix(const MixInput& input, uint8_t* dst);

  private:
    void CompositeLayer(const LayerNode& node, int32_t canvas_w,
                        int32_t canvas_h, uint8_t* dst);
};

}  // namespace bg

#endif  // BG_ENGINE_MIXER_CPU_LAYER_MIXER_H
