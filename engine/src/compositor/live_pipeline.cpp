// engine/src/compositor/live_pipeline.cpp

#include "live_pipeline.h"

#include "mixer/mask_ops.h"

#include <cmath>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <sstream>

namespace bg::compositor {

namespace {

std::string EscapeJsString(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '\\' || c == '\'' || c == '"') {
            out.push_back('\\');
            out.push_back(c);
        } else if (c == '\n') {
            out += "\\n";
        } else {
            out.push_back(c);
        }
    }
    return out;
}

}  // namespace

void LivePipeline::Attach(RenderGraphStore* store, int32_t canvas_w,
                          int32_t canvas_h) {
    store_ = store;
    canvas_w_ = canvas_w;
    canvas_h_ = canvas_h;
    live_overlay_.assign(static_cast<size_t>(canvas_w) * canvas_h * 4, 0);
}

void LivePipeline::set_enabled(bool on) {
    enabled_ = on;
    if (!on) {
        mode_ = PipelineMode::Disabled;
        ClearVisibilityFilter();
        cache_.Clear();
        have_live_overlay_ = false;
        capture_queue_.clear();
        capture_awaiting_paint_ = false;
    }
}

bool LivePipeline::GraphIsSupported(const ProtocolSnapshot& snap) const {
    if (snap.layers.empty()) return false;
    for (const auto& layer : snap.layers) {
        if (!layer.unsupported.empty()) return false;
        // Fractional rotation is rejected by the mixer; also reject here so we
        // never enter Capturing for a graph we cannot compose.
        const float rot = layer.rotation_deg;
        const float rounded = std::round(rot * 4.0f) / 4.0f;
        if (rounded != std::floor(rounded)) return false;
        if (layer.scale_x <= 0.0f || layer.scale_y <= 0.0f) return false;
    }
    return true;
}

std::vector<std::string> LivePipeline::CacheableLayerIds(
    const ProtocolSnapshot& snap) const {
    std::vector<std::string> ids;
    for (const auto& layer : snap.layers) {
        if (layer.kind == ProtocolNodeKind::CachedBitmap) {
            ids.push_back(layer.id);
        }
    }
    return ids;
}

std::vector<std::string> LivePipeline::LiveLayerIds(
    const ProtocolSnapshot& snap) const {
    std::vector<std::string> ids;
    for (const auto& layer : snap.layers) {
        if (layer.kind == ProtocolNodeKind::LiveHtml) {
            ids.push_back(layer.id);
        }
    }
    return ids;
}

void LivePipeline::RequestVisibilityFilter(
    const std::vector<std::string>& ids) {
    if (!browser_) return;
    CefRefPtr<CefFrame> frame = browser_->GetMainFrame();
    if (!frame) return;
    std::ostringstream js;
    js << "(function(){if(!window.__titulus||!window.__titulus.setLayerVisibilityFilter)return;";
    js << "window.__titulus.setLayerVisibilityFilter('*',";
    if (ids.empty()) {
        js << "null";
    } else {
        js << "[";
        for (size_t i = 0; i < ids.size(); ++i) {
            if (i) js << ",";
            js << "'" << EscapeJsString(ids[i]) << "'";
        }
        js << "]";
    }
    js << ");})();";
    frame->ExecuteJavaScript(js.str(), frame->GetURL(), 0);
}

void LivePipeline::ClearVisibilityFilter() {
    RequestVisibilityFilter({});
    // Empty vector still serialises to null via the empty branch above — wait,
    // looking at RequestVisibilityFilter: empty ids → null. Good.
}

void LivePipeline::BeginCapturePass() {
    if (!store_ || !store_->HasSnapshot()) {
        mode_ = PipelineMode::FallbackMonolith;
        stats_.last_fallback_reason = "no_graph_snapshot";
        return;
    }
    const ProtocolSnapshot* snap = store_->Current();
    if (!snap || !GraphIsSupported(*snap)) {
        mode_ = PipelineMode::FallbackMonolith;
        stats_.last_fallback_reason = "unsupported_graph";
        ++stats_.fallback_frames;
        return;
    }
    capture_queue_ = CacheableLayerIds(*snap);
    if (capture_queue_.empty()) {
        // Only live layers — still useful: we compose live overlays alone.
        mode_ = PipelineMode::Composing;
        last_seen_revision_ = snap->revision;
        return;
    }
    capture_index_ = 0;
    capture_awaiting_paint_ = false;
    mode_ = PipelineMode::Capturing;
    ++stats_.capture_passes;
    AdvanceCapture();
}

void LivePipeline::AdvanceCapture() {
    if (capture_index_ >= capture_queue_.size()) {
        ClearVisibilityFilter();
        mode_ = PipelineMode::Composing;
        if (store_ && store_->Current()) {
            last_seen_revision_ = store_->Current()->revision;
        }
        return;
    }
    RequestVisibilityFilter({capture_queue_[capture_index_]});
    capture_awaiting_paint_ = true;
    // The next OnPaint (after the caller's BeginFrame) is attributed to this
    // layer. Capture seq is stamped in OnPaint.
}

void LivePipeline::OnTick() {
    if (!enabled_) return;
    if (mode_ == PipelineMode::FallbackMonolith) return;
    if (!store_ || !store_->HasSnapshot()) return;

    const ProtocolSnapshot* snap = store_->Current();
    if (!snap) return;

    // New graph revision → recapture.
    if (snap->revision != last_seen_revision_
        && mode_ != PipelineMode::Capturing) {
        cache_.Clear();
        have_live_overlay_ = false;
        BeginCapturePass();
        return;
    }

    if (mode_ == PipelineMode::Disabled && enabled_) {
        BeginCapturePass();
        return;
    }

    // While composing with live layers: ask the page to show only live layers
    // so the next BeginFrame/OnPaint produces a cheap live overlay.
    if (mode_ == PipelineMode::Composing) {
        const auto live = LiveLayerIds(*snap);
        if (!live.empty()) {
            RequestVisibilityFilter(live);
        } else {
            ClearVisibilityFilter();
        }
    }
}

PaintDisposition LivePipeline::OnPaint(const uint8_t* bgra, int width,
                                       int height, uint64_t paint_seq) {
    if (!enabled_ || mode_ == PipelineMode::Disabled
        || mode_ == PipelineMode::FallbackMonolith) {
        return PaintDisposition::ForwardToRing;
    }

    if (mode_ == PipelineMode::Capturing && capture_awaiting_paint_) {
        if (capture_index_ < capture_queue_.size()) {
            // Store the full-canvas paint as this layer's source. For POC the
            // layer is shown alone (others display:none), so the canvas is
            // transparent except the layer's pixels — Mix will src-over them.
            cache_.Put(capture_queue_[capture_index_], bgra, width, height,
                       paint_seq);
            ++capture_index_;
            capture_awaiting_paint_ = false;
            AdvanceCapture();
            return PaintDisposition::ConsumedByCapture;
        }
    }

    if (mode_ == PipelineMode::Composing) {
        // Live overlay: keep the full-canvas paint (live layers only visible)
        // and let ComposeInto blend it over the cached sources.
        const size_t bytes = static_cast<size_t>(width) * height * 4;
        if (live_overlay_.size() != bytes) {
            live_overlay_.assign(bytes, 0);
        }
        std::memcpy(live_overlay_.data(), bgra, bytes);
        have_live_overlay_ = true;
        canvas_w_ = width;
        canvas_h_ = height;
        return PaintDisposition::ConsumedByCompose;
    }

    return PaintDisposition::ForwardToRing;
}

bool LivePipeline::NeedsLivePaint() const {
    if (mode_ != PipelineMode::Composing || !store_ || !store_->HasSnapshot()) {
        return false;
    }
    const ProtocolSnapshot* snap = store_->Current();
    if (!snap) return false;
    return !LiveLayerIds(*snap).empty();
}

void LivePipeline::BuildMixInputFromCache(MixInput& out,
                                          const ProtocolSnapshot& snap) const {
    out.canvas_width = canvas_w_;
    out.canvas_height = canvas_h_;
    out.layers.clear();

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
        if (layer.kind == ProtocolNodeKind::LiveHtml) {
            // Live layers are carried by the live_overlay_ full-canvas paint
            // (composited after the Mix of cached sources). Skip here.
            if (pending_mask) pending_mask.reset();
            continue;
        }
        const LayerBitmap* bmp = cache_.Get(layer.id);
        if (!bmp) continue;

        LayerNode node;
        node.buffer.data = bmp->bgra.data();
        node.buffer.width = bmp->width;
        node.buffer.height = bmp->height;
        node.buffer.stride_bytes = 0;
        // Cached paints are already in canvas space (full-canvas CEF snapshot
        // with only this layer visible). Identity layout places them 1:1.
        node.layout = LayerLayout::Identity(bmp->width, bmp->height);
        node.opacity = layer.opacity;
        if (pending_mask) {
            node.mask = *pending_mask;
            pending_mask.reset();
        }
        out.layers.push_back(node);
    }
}

bool LivePipeline::ComposeInto(uint8_t* dst, int32_t dst_w, int32_t dst_h) {
    if (!enabled_ || mode_ != PipelineMode::Composing || !store_
        || !store_->HasSnapshot()) {
        return false;
    }
    const ProtocolSnapshot* snap = store_->Current();
    if (!snap) return false;

    // Require every cacheable layer to be present.
    for (const auto& id : CacheableLayerIds(*snap)) {
        if (!cache_.Has(id)) {
            stats_.last_fallback_reason = "missing_cache:" + id;
            ++stats_.fallback_frames;
            mode_ = PipelineMode::FallbackMonolith;
            ClearVisibilityFilter();
            return false;
        }
    }

    MixInput input;
    BuildMixInputFromCache(input, *snap);
    input.canvas_width = dst_w;
    input.canvas_height = dst_h;

    // Start from transparent; Mix writes src-over of cached sources.
    std::memset(dst, 0, static_cast<size_t>(dst_w) * dst_h * 4);

    SyntheticSnapshot synth;
    synth.input = input;
    // Bitmaps are owned by cache_; synth.bitmaps stays empty (MixInput holds
    // raw pointers into the cache).
    auto res = compositor_.Composite(synth, dst_w, dst_h, dst);
    if (!res.ok) {
        stats_.last_fallback_reason = res.fallback_reasons.empty()
            ? "mixer_unsupported"
            : res.fallback_reasons.front();
        ++stats_.fallback_frames;
        mode_ = PipelineMode::FallbackMonolith;
        ClearVisibilityFilter();
        return false;
    }
    stats_.last_compose_ns = res.compose_ns;

    // Src-over the live overlay (full canvas with only live layers visible).
    if (have_live_overlay_
        && live_overlay_.size()
            == static_cast<size_t>(dst_w) * dst_h * 4) {
        const size_t pixels = static_cast<size_t>(dst_w) * dst_h;
        for (size_t i = 0; i < pixels; ++i) {
            const uint8_t* s = live_overlay_.data() + i * 4;
            if (s[3] == 0) continue;
            uint8_t* d = dst + i * 4;
            const int sa = s[3];
            const int da = d[3];
            const int inv = 255 - sa;
            const int out_a = sa + da * inv / 255;
            if (out_a == 0) {
                d[0] = d[1] = d[2] = d[3] = 0;
                continue;
            }
            for (int c = 0; c < 3; ++c) {
                d[c] = static_cast<uint8_t>(
                    (s[c] * sa + d[c] * da * inv / 255 + out_a / 2) / out_a);
            }
            d[3] = static_cast<uint8_t>(out_a);
        }
    }

    ++stats_.composed_frames;
    return true;
}

}  // namespace bg::compositor
