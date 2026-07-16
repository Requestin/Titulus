// engine/src/mixer/cpu_layer_mixer.h
//
// CPU implementation of the Doc02 layered compositor. Walks the MixInput
// layer list back-to-front, applies masks, affine layouts and opacity, and
// writes premultiplied-alpha src-over matching CEF OSR OnPaint.

#ifndef BG_ENGINE_MIXER_CPU_LAYER_MIXER_H
#define BG_ENGINE_MIXER_CPU_LAYER_MIXER_H

#include "render_graph_types.h"

#include <cstdint>
#include <memory>
#include <span>
#include <vector>

namespace bg {

class CpuLayerMixer {
  public:
    CpuLayerMixer();
    ~CpuLayerMixer();
    CpuLayerMixer(const CpuLayerMixer&) = delete;
    CpuLayerMixer& operator=(const CpuLayerMixer&) = delete;
    CpuLayerMixer(CpuLayerMixer&&) = delete;
    CpuLayerMixer& operator=(CpuLayerMixer&&) = delete;

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

    // Blend only disjoint canvas-space regions into an existing destination.
    // The caller owns clearing those regions before this call.
    bool MixRegions(const MixInput& input, uint8_t* dst,
                    std::span<const LayerRect> regions);

  private:
    struct WorkerPool;
    void MixValidated(const MixInput& input, uint8_t* dst);
    void CompositeRange(const MixInput& input, uint8_t* dst,
                        int32_t clip_x0, int32_t clip_y0,
                        int32_t clip_x1, int32_t clip_y1);
    void CompositeLayer(const LayerNode& node, int32_t canvas_w,
                        int32_t canvas_h, uint8_t* dst,
                        int32_t clip_x0, int32_t clip_y0,
                        int32_t clip_x1, int32_t clip_y1);
    std::unique_ptr<WorkerPool> worker_pool_;
};

}  // namespace bg

#endif  // BG_ENGINE_MIXER_CPU_LAYER_MIXER_H
