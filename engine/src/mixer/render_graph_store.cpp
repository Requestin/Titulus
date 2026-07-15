// engine/src/mixer/render_graph_store.cpp

#include "render_graph_store.h"

#include <utility>

namespace bg {

bool RenderGraphStore::Commit(ProtocolSnapshot snapshot) {
    if (have_snapshot_ && snapshot.revision <= current_.revision) {
        ++stats_.stale_dropped;
        return false;
    }
    stats_.layer_count = snapshot.layers.size();
    stats_.current_revision = snapshot.revision;
    current_ = std::move(snapshot);
    have_snapshot_ = true;
    ++stats_.accepted;
    return true;
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
