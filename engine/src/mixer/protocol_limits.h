// engine/src/mixer/protocol_limits.h
//
// Bounded layer protocol v1 size limits. Bumping these requires a graph hash
// rotation in the shadow store and a paired K2 re-run.

#ifndef BG_ENGINE_MIXER_PROTOCOL_LIMITS_H
#define BG_ENGINE_MIXER_PROTOCOL_LIMITS_H

#include <cstddef>
#include <cstdint>

namespace bg::protocol {

inline constexpr size_t kMaxLayers = 64;
inline constexpr size_t kMaxDirtyDomainsPerLayer = 4;
inline constexpr size_t kMaxUnsupportedReasonsPerLayer = 8;
inline constexpr size_t kMaxAffectedSourcesPerMask = kMaxLayers;
inline constexpr size_t kMaxLayerIdBytes = 128;
inline constexpr size_t kMaxTemplateIdBytes = 128;
inline constexpr size_t kMaxSnapshotJsonBytes = 64 * 1024;
inline constexpr int32_t kMaxLayerExtent = 8192;
inline constexpr uint64_t kInitialRevision = 0;

}  // namespace bg::protocol

#endif  // BG_ENGINE_MIXER_PROTOCOL_LIMITS_H
