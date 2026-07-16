// engine/src/compositor/layered_compositor.h
//
// Orchestrator that turns a parsed protocol snapshot + (synthetic, for the
// POC) source bitmaps into a single BGRA8 frame via the scalar CpuLayerMixer.
//
// Gating: this code is reached only when `BG_LAYERED_COMPOSITOR=1` is set.
// In all other configurations the engine keeps the legacy monolith CEF path.
// The orchestrator is a strict opt-in: if IsSupported(input) is false, the
// caller must keep the monolith and report the fallback reasons.

#ifndef BG_ENGINE_COMPOSITOR_LAYERED_COMPOSITOR_H
#define BG_ENGINE_COMPOSITOR_LAYERED_COMPOSITOR_H

#include "mixer/cpu_layer_mixer.h"
#include "mixer/protocol_types.h"
#include "mixer/render_graph_types.h"
#include "synthetic_snapshot.h"

#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace bg::compositor {

struct CompositeResult {
    bool ok = false;            // false when fallback reasons are non-empty
    std::vector<std::string> fallback_reasons;
    int64_t compose_ns = 0;     // wall-clock spent inside Mix()
};

class LayeredCompositor {
  public:
    LayeredCompositor() = default;

    // Composite a snapshot into `dst` (BGRA8, canvas_w * canvas_h * 4 bytes).
    // Returns ok=false when the snapshot contains an unsupported operator; the
    // caller must fall back to the legacy monolith and forward
    // `fallback_reasons` to telemetry.
    CompositeResult Composite(const SyntheticSnapshot& snapshot, int32_t canvas_w,
                              int32_t canvas_h, uint8_t* dst);

    CompositeResult CompositeRegions(
        const SyntheticSnapshot& snapshot, int32_t canvas_w,
        int32_t canvas_h, uint8_t* dst,
        std::span<const LayerRect> regions);

    // Read the underlying mixer for callers that already hold a MixInput.
    CpuLayerMixer& mixer() { return mixer_; }

  private:
    CpuLayerMixer mixer_;
};

}  // namespace bg::compositor

#endif  // BG_ENGINE_COMPOSITOR_LAYERED_COMPOSITOR_H
