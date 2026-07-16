// engine/src/mixer/protocol_types.h
//
// Bounded layer protocol v1 (Doc02 PR3).
//
// Wire format on the CEF <-> engine boundary:
//   BGGRAPH v1 <json-one-line>
//
// Where JSON has shape:
//   {"type":"snapshot","template_id":"<id>","graph_rev":42,
//    "state_rev":1001,"layers":[
//     {"id":"<id>","kind":"cached_bitmap"|"live_html"|"mask_operator",
//      "dirty":["content_dirty"|"props_dirty"|"mask_dirty"],
//      "opacity":1.0,"mask_mode":"none"|"normal"|"inverted",
//      "rect":[x,y,w,h],"affects":["source-id"],"m":[a,b,c,d,e,f],
//      "x":0,"y":0,"sx":1.0,"sy":1.0,
//      "rot":0.0,"ax":0.0,"ay":0.0,"sw":0,"sh":0,
//      "unsupported":["fractional_rotation"|...]
//     }, ...]}
//
// Bounds enforced by the parser (see protocol_limits.h): layer count, string
// length, layer rect extent. Anything outside the bounds is rejected and the
// caller must keep the legacy monolith.

#ifndef BG_ENGINE_MIXER_PROTOCOL_TYPES_H
#define BG_ENGINE_MIXER_PROTOCOL_TYPES_H

#include <cstdint>
#include <string>
#include <vector>

namespace bg {

enum class ProtocolNodeKind : uint8_t {
    CachedBitmap,
    LiveHtml,
    MaskOperator,
};

enum class ProtocolDirtyDomain : uint8_t {
    ContentDirty,
    PropsDirty,
    MaskDirty,
};

enum class ProtocolMaskMode : uint8_t {
    None,
    Normal,
    Inverted,
};

enum class ProtocolUnsupportedReason : uint8_t {
    FractionalRotation,
    NonPositiveScale,
    NonRectMaskShape,
    OversizedLayer,
    ThreeDTransform,
    NonNormalBlend,
};

struct ProtocolLayerRect {
    int32_t x = 0;
    int32_t y = 0;
    int32_t width = 0;
    int32_t height = 0;
};

struct ProtocolLayerNode {
    std::string id;
    ProtocolNodeKind kind = ProtocolNodeKind::CachedBitmap;
    std::vector<ProtocolDirtyDomain> dirty;
    float opacity = 1.0f;
    ProtocolMaskMode mask_mode = ProtocolMaskMode::None;
    ProtocolLayerRect mask_rect;
    std::vector<std::string> affected_source_ids;
    ProtocolLayerRect layout_position;  // canvas-space top-left
    float scale_x = 1.0f;
    float scale_y = 1.0f;
    float rotation_deg = 0.0f;
    float anchor_x = 0.0f;
    float anchor_y = 0.0f;
    int32_t source_w = 0;
    int32_t source_h = 0;
    bool has_affine = false;
    // Source-local -> canvas matrix [m00,m01,m02,m10,m11,m12].
    float affine[6] = {1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f};
    std::vector<ProtocolUnsupportedReason> unsupported;
};

struct ProtocolSnapshot {
    // Stable authoring template id used by the production allowlist.
    std::string template_id;
    // Topology/content revision. A change requires selective source recapture.
    uint64_t graph_revision = 0;
    // Monotonic props/mask state revision inside one graph revision.
    uint64_t state_revision = 0;
    // Cacheable source ids whose pixels changed in this state revision.
    std::vector<std::string> invalidated_layer_ids;
    std::vector<ProtocolLayerNode> layers;
};

const char* ProtocolNodeKindLabel(ProtocolNodeKind kind);
const char* ProtocolDirtyDomainLabel(ProtocolDirtyDomain d);
const char* ProtocolMaskModeLabel(ProtocolMaskMode m);
const char* ProtocolUnsupportedReasonLabel(ProtocolUnsupportedReason r);

}  // namespace bg

#endif  // BG_ENGINE_MIXER_PROTOCOL_TYPES_H
