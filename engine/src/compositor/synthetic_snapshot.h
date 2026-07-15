// engine/src/compositor/synthetic_snapshot.h
//
// Deterministic synthetic source bitmaps for the Doc02 layered compositor
// POC. Each cacheable layer gets a stable colour derived from its id hash so
// a bench run is reproducible and the golden diff can spot a missing source.
//
// This is intentionally synthetic: it lets us measure the mixer + cache
// overhead in isolation, without the CEF raster cost that is already known
// from Phase 18. Live CEF snapshot capture lands in a later PR.

#ifndef BG_ENGINE_COMPOSITOR_SYNTHETIC_SNAPSHOT_H
#define BG_ENGINE_COMPOSITOR_SYNTHETIC_SNAPSHOT_H

#include "mixer/protocol_types.h"
#include "mixer/render_graph_types.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace bg::compositor {

// Fills `out` with a deterministic BGRA8 bitmap for one layer. Dimensions are
// taken from the layer node's source_w / source_h. `out` must be at least
// `sw * sh * 4` bytes; pass `stride_bytes = 0` for tight packing.
void FillSyntheticLayer(const ProtocolLayerNode& node, uint8_t* out,
                        size_t out_bytes);

// Builds a full MixInput (in mixer types) from a parsed protocol snapshot.
// Pixel-bearing layers receive synthetic bitmaps; live HTML layers fall back
// to a "live placeholder" bitmap so the compositor can still place them; mask
// operator layers become mask ops on the next pixel-bearing siblings (no
// bitmap themselves). Storage for all source bitmaps is held in `pool`, which
// the caller must keep alive for the lifetime of the returned MixInput.
struct SyntheticSnapshot {
    std::vector<std::vector<uint8_t>> bitmaps;  // backing storage
    MixInput input;
};

SyntheticSnapshot BuildSyntheticSnapshot(const ProtocolSnapshot& snap);

}  // namespace bg::compositor

#endif  // BG_ENGINE_COMPOSITOR_SYNTHETIC_SNAPSHOT_H
