// engine/src/mixer/render_graph_store.cpp

#include "render_graph_store.h"

#include <utility>

namespace bg {

bool RenderGraphStore::Commit(ProtocolSnapshot snapshot) {
    if (have_snapshot_) {
        const bool older_graph =
            snapshot.graph_revision < current_.graph_revision;
        const bool stale_state =
            snapshot.graph_revision == current_.graph_revision
            && snapshot.state_revision <= current_.state_revision;
        if (older_graph || stale_state) {
            ++stats_.stale_dropped;
            return false;
        }
    }
    stats_.layer_count = snapshot.layers.size();
    stats_.current_graph_revision = snapshot.graph_revision;
    stats_.current_state_revision = snapshot.state_revision;
    current_ = std::move(snapshot);
    have_snapshot_ = true;
    ++stats_.accepted;
    return true;
}

void RenderGraphStore::Reset() {
    current_ = {};
    have_snapshot_ = false;
    stats_.current_graph_revision = 0;
    stats_.current_state_revision = 0;
    stats_.layer_count = 0;
}

void RenderGraphStore::RecordMalformed(std::string detail) {
    ++stats_.malformed;
    stats_.last_error_detail = std::move(detail);
}

void RenderGraphStore::RecordBoundsViolation(std::string detail) {
    ++stats_.bounds_violations;
    stats_.last_error_detail = std::move(detail);
}

void RenderGraphStore::RecordUnsupported(std::string detail) {
    ++stats_.unsupported;
    stats_.last_error_detail = std::move(detail);
}

}  // namespace bg
