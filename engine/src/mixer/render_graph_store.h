// engine/src/mixer/render_graph_store.h
//
// Shadow-mode store for the Doc02 operator-aware render graph. Holds the
// latest parsed snapshot plus a tiny ring of recent revisions so that diff
// debugging can show what the runtime is publishing — without the engine
// actually consuming the graph for compositing.
//
// Shadow mode contract:
//   - Thread of origin: CEF UI thread (OnConsoleMessage). All public methods
//     are intended to be called from there. We do not lock on the hot path.
//   - The store never touches the render pump or the FrameRing.
//   - A snapshot whose `revision` is older than or equal to the stored one
//     is dropped silently.
//   - Malformed or out-of-bounds messages are recorded as a failure counter
//     with the last reason label, again without affecting rendering.

#ifndef BG_ENGINE_MIXER_RENDER_GRAPH_STORE_H
#define BG_ENGINE_MIXER_RENDER_GRAPH_STORE_H

#include "protocol_types.h"

#include <cstdint>
#include <string>
#include <vector>

namespace bg {

struct RenderGraphStoreStats {
    uint64_t accepted = 0;          // snapshots committed
    uint64_t stale_dropped = 0;     // revision <= current
    uint64_t malformed = 0;         // parser returned MalformedJson/Missing*
    uint64_t bounds_violations = 0; // parser returned BoundsViolation
    uint64_t unsupported = 0;       // unsupported version or type
    uint64_t current_revision = 0;
    size_t layer_count = 0;
    std::string last_error_detail;
};

class RenderGraphStore {
  public:
    RenderGraphStore() = default;

    // Commit a freshly-parsed snapshot. Returns true if the snapshot was
    // accepted (revision strictly greater than current). Returns false for
    // stale revisions; the snapshot is discarded either way (caller still
    // owns the parsed payload and can inspect it).
    bool Commit(ProtocolSnapshot snapshot);

    // Read-only view of the current snapshot. Pointer is stable until the next
    // Commit; do not retain across calls.
    const ProtocolSnapshot* Current() const { return HasSnapshot() ? &current_ : nullptr; }

    bool HasSnapshot() const { return have_snapshot_; }

    const RenderGraphStoreStats& Stats() const { return stats_; }

    // Record a parse failure for telemetry without storing anything.
    void RecordMalformed(std::string detail);
    void RecordBoundsViolation(std::string detail);
    void RecordUnsupported(std::string detail);

  private:
    ProtocolSnapshot current_;
    bool have_snapshot_ = false;
    RenderGraphStoreStats stats_;
};

}  // namespace bg

#endif  // BG_ENGINE_MIXER_RENDER_GRAPH_STORE_H
