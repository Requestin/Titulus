// engine/src/mixer/render_graph_types.h
//
// Doc02 layered compositor scalar reference. Strongly typed nodes for the
// mixer protocol described in `docs/performance investigation/02-cpu-layer-compositor.md`.
//
// The mixer is intentionally a no-frills scalar implementation:
// - premultiplied-alpha src-over, matching CEF OSR BGRA8;
// - stable z-order by input order (back -> front);
// - axis-aligned normal/inverted rect masks;
// - arbitrary finite 2D affine transforms;
// - bounded by canvas dimensions.
//
// SIMD kernels and parallelism land in a later PR and must reproduce these
// goldens exactly.

#ifndef BG_ENGINE_MIXER_RENDER_GRAPH_TYPES_H
#define BG_ENGINE_MIXER_RENDER_GRAPH_TYPES_H

#include <cstdint>
#include <limits>
#include <optional>
#include <vector>

namespace bg {

enum class MaskMode : uint8_t {
    Normal,    // keep only pixels inside the mask rect
    Inverted,  // keep only pixels outside the mask rect
};

// Axis-aligned integer rect in canvas space. Used for both masks and the
// canvas clip.
struct LayerRect {
    int32_t x = 0;
    int32_t y = 0;
    int32_t width = 0;
    int32_t height = 0;
};

// Forward source-pixel -> canvas-pixel affine transform:
//
//   canvas_x = m00 * source_x + m01 * source_y + m02
//   canvas_y = m10 * source_x + m11 * source_y + m12
//
// Runtime graph snapshots use this form because nested group transforms cannot
// always be represented losslessly as one translation/rotation/scale tuple.
struct LayerAffine {
    float m00 = 1.0f;
    float m01 = 0.0f;
    float m02 = 0.0f;
    float m10 = 0.0f;
    float m11 = 1.0f;
    float m12 = 0.0f;
};

// Affine layout for a cached bitmap. Position is canvas-pixel top-left;
// scale multiplies source dimensions; rotation_deg is around (anchor_x,
// anchor_y). When `affine` is present it is authoritative and the legacy tuple
// is ignored.
struct LayerLayout {
    int32_t position_x = 0;
    int32_t position_y = 0;
    float scale_x = 1.0f;
    float scale_y = 1.0f;
    float rotation_deg = 0.0f;
    float anchor_x = 0.0f;
    float anchor_y = 0.0f;
    int32_t source_w = 0;
    int32_t source_h = 0;
    std::optional<LayerAffine> affine;

    static LayerLayout Identity(int32_t w, int32_t h) {
        LayerLayout out;
        out.source_w = w;
        out.source_h = h;
        out.scale_x = 1.0f;
        out.scale_y = 1.0f;
        return out;
    }
};

// Read-only reference into a source pixel buffer. The mixer never writes
// through these pointers.
struct LayerBufferRef {
    const uint8_t* data = nullptr;
    int32_t width = 0;
    int32_t height = 0;
    int32_t stride_bytes = 0;  // bytes per row; 0 => width * 4
};

struct MaskOp {
    MaskMode mode = MaskMode::Normal;
    LayerRect rect;
};

struct LayerNode;

using LayerNodeList = std::vector<LayerNode>;

struct LayerNode {
    LayerBufferRef buffer;
    LayerLayout layout;
    // A source may be inside nested mask scopes. All masks are evaluated in
    // canvas space and must pass for the source pixel to survive.
    std::vector<MaskOp> masks;
    float opacity = 1.0f;
};

// Atomic mix snapshot consumed by the pump thread. Layers are stable z-order
// (back -> front); the producer guarantees the buffer pointers outlive Mix().
struct MixInput {
    int32_t canvas_width = 0;
    int32_t canvas_height = 0;
    LayerNodeList layers;
};

// Fallback reason codes reported when a MixInput cannot be served by this
// mixer version.
enum class FallbackReason : uint8_t {
    FractionalRotation,  // retained for protocol-v1 compatibility; no longer emitted
    NonPositiveScale,    // scale_x or scale_y <= 0
    NonRectMaskShape,    // future ellipse / matte support lives in a later PR
    OversizedLayer,      // source buffer or layout exceeds internal limits
    InvalidBuffer,       // null data, invalid dimensions, or invalid stride
    NonFiniteTransform,  // NaN/Inf transform or opacity
    SingularTransform,   // affine transform cannot be inverted
};

const char* FallbackReasonLabel(FallbackReason reason);

}  // namespace bg

#endif  // BG_ENGINE_MIXER_RENDER_GRAPH_TYPES_H
