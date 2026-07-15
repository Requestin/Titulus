// engine/src/compositor/synthetic_snapshot.cpp

#include "synthetic_snapshot.h"

#include <cstring>

namespace bg::compositor {

namespace {

uint32_t HashId(const std::string& id) {
    // FNV-1a 32-bit. Stable across runs and platforms for ASCII ids.
    uint32_t h = 2166136261u;
    for (unsigned char c : id) {
        h ^= c;
        h *= 16777619u;
    }
    return h;
}

uint8_t ChannelColor(uint32_t hash, int shift) {
    // Mix the hash so each channel has visible variation. Avoid 0/255 extremes
    // so blend math stays inside [40, 215] and rounding is observable.
    const uint8_t v = static_cast<uint8_t>((hash >> shift) & 0xff);
    return static_cast<uint8_t>(40 + (v % 176));
}

}  // namespace

void FillSyntheticLayer(const ProtocolLayerNode& node, uint8_t* out,
                        size_t out_bytes) {
    const int32_t w = node.source_w > 0 ? node.source_w : 1;
    const int32_t h = node.source_h > 0 ? node.source_h : 1;
    const size_t need = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
    if (out_bytes < need) return;
    const uint32_t hash = HashId(node.id);
    const uint8_t b = ChannelColor(hash, 0);
    const uint8_t g = ChannelColor(hash, 8);
    const uint8_t r = ChannelColor(hash, 16);
    // Half of the synthetic sources use partial alpha so the blend path
    // exercises src-over rather than a trivial overwrite.
    const uint8_t a = (hash & 0x40) ? 0xff : 0x80;
    const uint32_t px = (static_cast<uint32_t>(a) << 24)
        | (static_cast<uint32_t>(r) << 16)
        | (static_cast<uint32_t>(g) << 8)
        | static_cast<uint32_t>(b);
    for (size_t i = 0; i < static_cast<size_t>(w) * h; ++i) {
        std::memcpy(out + i * 4, &px, 4);
    }
}

SyntheticSnapshot BuildSyntheticSnapshot(const ProtocolSnapshot& snap) {
    SyntheticSnapshot out;
    out.input.canvas_width = 0;
    out.input.canvas_height = 0;
    for (const auto& layer : snap.layers) {
        // Mask operator layers do not carry source pixels; emit them as pure
        // mask ops carried by the next pixel-bearing layer below.
        if (layer.kind == ProtocolNodeKind::MaskOperator) continue;
        // Track the canvas size from the largest source.
        out.input.canvas_width =
            std::max(out.input.canvas_width, layer.source_w);
        out.input.canvas_height =
            std::max(out.input.canvas_height, layer.source_h);
    }
    if (out.input.canvas_width == 0) out.input.canvas_width = 1;
    if (out.input.canvas_height == 0) out.input.canvas_height = 1;

    // Pending mask op carried from the most recent mask operator. The mixer
    // applies it to whatever pixel-bearing layer comes next; this matches the
    // render-graph semantics where masks affect their siblings.
    std::optional<MaskOp> pending_mask;
    for (const auto& layer : snap.layers) {
        if (layer.kind == ProtocolNodeKind::MaskOperator) {
            MaskOp op;
            op.mode = layer.mask_mode == ProtocolMaskMode::Inverted
                ? MaskMode::Inverted
                : MaskMode::Normal;
            op.rect = {layer.mask_rect.x, layer.mask_rect.y,
                       layer.mask_rect.width, layer.mask_rect.height};
            pending_mask = op;
            continue;
        }
        LayerNode node;
        node.layout.position_x = layer.layout_position.x;
        node.layout.position_y = layer.layout_position.y;
        node.layout.scale_x = layer.scale_x;
        node.layout.scale_y = layer.scale_y;
        node.layout.rotation_deg = layer.rotation_deg;
        node.layout.anchor_x = layer.anchor_x;
        node.layout.anchor_y = layer.anchor_y;
        node.layout.source_w = layer.source_w;
        node.layout.source_h = layer.source_h;
        node.opacity = layer.opacity;
        if (pending_mask) {
            node.mask = *pending_mask;
            pending_mask.reset();
        }
        std::vector<uint8_t> bitmap(
            static_cast<size_t>(layer.source_w > 0 ? layer.source_w : 1)
            * static_cast<size_t>(layer.source_h > 0 ? layer.source_h : 1) * 4);
        ProtocolLayerNode fillable = layer;
        FillSyntheticLayer(fillable, bitmap.data(), bitmap.size());
        node.buffer.data = bitmap.data();
        node.buffer.width = layer.source_w > 0 ? layer.source_w : 1;
        node.buffer.height = layer.source_h > 0 ? layer.source_h : 1;
        node.buffer.stride_bytes = 0;
        out.bitmaps.push_back(std::move(bitmap));
        out.input.layers.push_back(node);
    }
    return out;
}

}  // namespace bg::compositor
