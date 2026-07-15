// engine/src/compositor/layered_compositor.cpp

#include "layered_compositor.h"

#include "mixer/render_graph_types.h"

#include <chrono>

namespace bg::compositor {

CompositeResult LayeredCompositor::Composite(const SyntheticSnapshot& snapshot,
                                             int32_t canvas_w,
                                             int32_t canvas_h, uint8_t* dst) {
    CompositeResult res;
    // We rebuild the input with the requested canvas size; the synthetic
    // snapshot already holds layer buffer pointers into its own storage.
    MixInput input = snapshot.input;
    input.canvas_width = canvas_w;
    input.canvas_height = canvas_h;
    auto reasons = mixer_.FallbackReasons(input);
    if (!reasons.empty()) {
        for (auto r : reasons) {
            res.fallback_reasons.push_back(FallbackReasonLabel(r));
        }
        return res;
    }
    const auto t0 = std::chrono::steady_clock::now();
    mixer_.Mix(input, dst);
    const auto t1 = std::chrono::steady_clock::now();
    res.compose_ns =
        std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count();
    res.ok = true;
    return res;
}

}  // namespace bg::compositor
