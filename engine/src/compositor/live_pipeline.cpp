// engine/src/compositor/live_pipeline.cpp

#include "live_pipeline.h"

#include "mixer/affine_sampler.h"
#include "mixer/mask_ops.h"

#include <algorithm>
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

bool CaptureMarkerMatches(const uint8_t* bgra, int width, int height,
                          uint64_t capture_seq) {
    if (!bgra || width < 4 || height < 4) return false;
    const auto matches = [&](int x, int shift) {
        const uint64_t value = capture_seq >> shift;
        const uint8_t expected_r = static_cast<uint8_t>(value & 0xFF);
        const uint8_t expected_g = static_cast<uint8_t>((value >> 8) & 0xFF);
        const uint8_t expected_b = static_cast<uint8_t>((value >> 16) & 0xFF);
        const uint8_t* pixel = bgra + static_cast<size_t>(x) * 4;
        return pixel[0] == expected_b && pixel[1] == expected_g
            && pixel[2] == expected_r && pixel[3] == 0xFF;
    };
    return matches(0, 0) && matches(3, 24);
}

bool SamePixelVisualState(const ProtocolLayerNode& left,
                          const ProtocolLayerNode& right) {
    return left.kind == right.kind
        && left.source_w == right.source_w
        && left.source_h == right.source_h
        && left.layout_position.x == right.layout_position.x
        && left.layout_position.y == right.layout_position.y
        && left.scale_x == right.scale_x
        && left.scale_y == right.scale_y
        && left.rotation_deg == right.rotation_deg
        && left.anchor_x == right.anchor_x
        && left.anchor_y == right.anchor_y
        && left.opacity == right.opacity
        && left.has_affine == right.has_affine
        && (!left.has_affine || left.affine == right.affine);
}

bool SameMaskVisualState(const ProtocolLayerNode& left,
                         const ProtocolLayerNode& right) {
    return left.kind == right.kind
        && left.mask_mode == right.mask_mode
        && left.mask_rect.x == right.mask_rect.x
        && left.mask_rect.y == right.mask_rect.y
        && left.mask_rect.width == right.mask_rect.width
        && left.mask_rect.height == right.mask_rect.height
        && left.affected_source_ids == right.affected_source_ids;
}

const ProtocolLayerNode* FindProtocolLayer(
    const ProtocolSnapshot& snapshot, const std::string& id) {
    const auto it = std::find_if(
        snapshot.layers.begin(), snapshot.layers.end(),
        [&id](const auto& layer) { return layer.id == id; });
    return it == snapshot.layers.end() ? nullptr : &*it;
}

const LayerNode* FindMixLayer(const ProtocolSnapshot& snapshot,
                              const MixInput& input,
                              const std::string& id) {
    size_t pixel_index = 0;
    for (const auto& layer : snapshot.layers) {
        if (layer.kind == ProtocolNodeKind::MaskOperator) continue;
        if (pixel_index >= input.layers.size()) return nullptr;
        if (layer.id == id) return &input.layers[pixel_index];
        ++pixel_index;
    }
    return nullptr;
}

}  // namespace

void LivePipeline::Attach(RenderGraphStore* store, int32_t canvas_w,
                          int32_t canvas_h) {
    store_ = store;
    canvas_w_ = canvas_w;
    canvas_h_ = canvas_h;
}

uint64_t LivePipeline::ComposeLatencyPercentileUs(
    uint32_t percentile) const {
    if (compose_latency_count_ == 0) return 0;
    std::array<int64_t, kComposeLatencySamples> sorted{};
    std::copy_n(
        compose_latency_ns_.begin(), compose_latency_count_, sorted.begin());
    std::sort(sorted.begin(), sorted.begin() + compose_latency_count_);
    const uint32_t bounded = std::min(percentile, 100u);
    const size_t index = static_cast<size_t>(
        (static_cast<uint64_t>(compose_latency_count_ - 1) * bounded) / 100);
    return static_cast<uint64_t>(sorted[index] / 1000);
}

void LivePipeline::set_enabled(bool on) {
    enabled_ = on;
    if (!on) {
        mode_ = PipelineMode::Disabled;
        ClearCaptureMode();
        cache_.Clear();
        capture_queue_.clear();
        capture_awaiting_ready_ = false;
        capture_awaiting_paint_ = false;
        capture_discard_next_paint_ = false;
        preparing_live_capture_ = false;
        selective_capture_ = false;
        capture_graph_revision_ = 0;
        live_layer_id_.clear();
        last_incremental_snapshot_.reset();
        pending_content_dirty_ids_.clear();
        live_update_generation_ = 0;
        last_composed_live_update_generation_ = 0;
        last_composed_graph_revision_ = 0;
        last_composed_state_revision_ = 0;
    }
}

bool LivePipeline::GraphIsSupported(const ProtocolSnapshot& snap) const {
    if (snap.layers.empty()) return false;
    size_t live_layers = 0;
    for (const auto& layer : snap.layers) {
        if (!layer.unsupported.empty()) return false;
        if (!std::isfinite(layer.rotation_deg)
            || !std::isfinite(layer.scale_x)
            || !std::isfinite(layer.scale_y)
            || !std::isfinite(layer.opacity)
            || layer.scale_x <= 0.0f || layer.scale_y <= 0.0f) {
            return false;
        }
        if (layer.kind == ProtocolNodeKind::LiveHtml) ++live_layers;
    }
    return live_layers <= 1;
}

bool LivePipeline::TemplateIsAllowed(const ProtocolSnapshot& snap) const {
    return template_allowlist_.empty()
        || std::find(
            template_allowlist_.begin(), template_allowlist_.end(),
            snap.template_id) != template_allowlist_.end();
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

void LivePipeline::RequestLayerCapture(const std::string& id) {
    ++capture_request_seq_;
    capture_waiting_seq_ = capture_request_seq_;
    capture_wait_ticks_ = 0;
    capture_awaiting_ready_ = true;
    capture_awaiting_paint_ = false;
    capture_discard_next_paint_ = false;
    if (!browser_) return;
    CefRefPtr<CefFrame> frame = browser_->GetMainFrame();
    if (!frame) return;
    std::ostringstream js;
    js << "(function(){if(!window.__titulus||"
          "!window.__titulus.setLayerCaptureMode){"
          "console.log('BGCAPTURE_ERROR "
       << capture_waiting_seq_
       << "');return;}Promise.resolve("
          "window.__titulus.setLayerCaptureMode('*','"
       << EscapeJsString(id) << "'," << kCapturePadding
       << "," << capture_waiting_seq_
       << ")).then(function(){requestAnimationFrame(function(){"
          "console.log('BGCAPTURE_READY "
       << capture_waiting_seq_
       << "');});}).catch(function(){console.log('BGCAPTURE_ERROR "
       << capture_waiting_seq_ << "');});})();";
    frame->ExecuteJavaScript(js.str(), frame->GetURL(), 0);
}

void LivePipeline::ClearCaptureMode() {
    if (!browser_) return;
    CefRefPtr<CefFrame> frame = browser_->GetMainFrame();
    if (!frame) return;
    const std::string js =
        "(function(){if(window.__titulus&&"
        "window.__titulus.setLayerCaptureMode){"
        "window.__titulus.setLayerCaptureMode('*',null,0);}})();";
    frame->ExecuteJavaScript(js, frame->GetURL(), 0);
}

void LivePipeline::EnterFallback(std::string reason) {
    mode_ = PipelineMode::FallbackMonolith;
    fallback_retry_on_state_ =
        reason.rfind("template_not_allowlisted:", 0) != 0;
    if (store_ && store_->Current()) {
        last_seen_revision_ = store_->Current()->graph_revision;
        last_seen_state_revision_ = store_->Current()->state_revision;
    }
    stats_.last_fallback_reason = std::move(reason);
    ++stats_.fallback_frames;
    ++stats_.capture_failures;
    capture_awaiting_ready_ = false;
    capture_awaiting_paint_ = false;
    capture_discard_next_paint_ = false;
    preparing_live_capture_ = false;
    selective_capture_ = false;
    last_incremental_snapshot_.reset();
    pending_content_dirty_ids_.clear();
    ClearCaptureMode();
}

void LivePipeline::BeginCapturePass() {
    if (!store_ || !store_->HasSnapshot()) {
        EnterFallback("no_graph_snapshot");
        return;
    }
    const ProtocolSnapshot* snap = store_->Current();
    if (!snap) {
        EnterFallback("no_graph_snapshot");
        return;
    }
    if (!TemplateIsAllowed(*snap)) {
        EnterFallback("template_not_allowlisted:" + snap->template_id);
        return;
    }
    if (!GraphIsSupported(*snap)) {
        EnterFallback("unsupported_graph");
        return;
    }
    capture_graph_revision_ = snap->graph_revision;
    capture_state_revision_ = snap->state_revision;
    selective_capture_ = false;
    live_layer_id_.clear();
    last_incremental_snapshot_.reset();
    pending_content_dirty_ids_.clear();
    capture_queue_ = CacheableLayerIds(*snap);
    const auto live = LiveLayerIds(*snap);
    auto pinned = capture_queue_;
    pinned.insert(pinned.end(), live.begin(), live.end());
    cache_.SetPinnedLayerIds(pinned);
    if (capture_queue_.empty()) {
        if (!live.empty()) {
            preparing_live_capture_ = true;
            live_layer_id_ = live.front();
            mode_ = PipelineMode::Capturing;
            RequestLayerCapture(live_layer_id_);
        } else {
            ClearCaptureMode();
            mode_ = PipelineMode::Composing;
            selective_capture_ = false;
            last_seen_revision_ = snap->graph_revision;
            last_seen_state_revision_ = snap->state_revision;
        }
        return;
    }
    capture_index_ = 0;
    capture_awaiting_paint_ = false;
    mode_ = PipelineMode::Capturing;
    ++stats_.capture_passes;
    AdvanceCapture();
}

void LivePipeline::BeginSelectiveCapture(const ProtocolSnapshot& snap) {
    if (!GraphIsSupported(snap)) {
        EnterFallback("unsupported_graph");
        return;
    }
    capture_queue_.clear();
    for (const auto& id : snap.invalidated_layer_ids) {
        const auto layer = std::find_if(
            snap.layers.begin(), snap.layers.end(),
            [&id](const auto& candidate) { return candidate.id == id; });
        if (layer == snap.layers.end()) {
            EnterFallback("invalidate_layer_missing:" + id);
            return;
        }
        if (layer->kind == ProtocolNodeKind::CachedBitmap) {
            capture_queue_.push_back(id);
        }
    }
    if (capture_queue_.empty()) {
        last_seen_revision_ = snap.graph_revision;
        last_seen_state_revision_ = snap.state_revision;
        return;
    }
    auto pinned = CacheableLayerIds(snap);
    const auto live = LiveLayerIds(snap);
    pinned.insert(pinned.end(), live.begin(), live.end());
    cache_.SetPinnedLayerIds(pinned);
    capture_graph_revision_ = snap.graph_revision;
    capture_state_revision_ = snap.state_revision;
    capture_index_ = 0;
    capture_awaiting_paint_ = false;
    preparing_live_capture_ = false;
    selective_capture_ = true;
    mode_ = PipelineMode::Capturing;
    ++stats_.capture_passes;
    AdvanceCapture();
}

void LivePipeline::AdvanceCapture() {
    if (capture_index_ >= capture_queue_.size()) {
        const ProtocolSnapshot* snap =
            store_ && store_->Current() ? store_->Current() : nullptr;
        const auto live = snap ? LiveLayerIds(*snap) : std::vector<std::string>{};
        if (!live.empty()) {
            preparing_live_capture_ = true;
            live_layer_id_ = live.front();
            RequestLayerCapture(live_layer_id_);
        } else {
            ClearCaptureMode();
            mode_ = PipelineMode::Composing;
            if (snap) {
                last_seen_revision_ = snap->graph_revision;
                last_seen_state_revision_ = snap->state_revision;
            }
        }
        return;
    }
    RequestLayerCapture(capture_queue_[capture_index_]);
}

void LivePipeline::OnTick() {
    if (!enabled_) return;
    if (!store_ || !store_->HasSnapshot()) return;

    const ProtocolSnapshot* snap = store_->Current();
    if (!snap) return;

    if (mode_ == PipelineMode::FallbackMonolith) {
        if (snap->graph_revision != last_seen_revision_
            || (fallback_retry_on_state_
                && snap->state_revision != last_seen_state_revision_)) {
            cache_.Clear();
            mode_ = PipelineMode::Disabled;
            BeginCapturePass();
        }
        return;
    }

    const bool newer_content_invalidation =
        snap->state_revision != capture_state_revision_
        && !snap->invalidated_layer_ids.empty();
    if (mode_ == PipelineMode::Capturing
        && (snap->graph_revision != capture_graph_revision_
            || newer_content_invalidation)) {
        cache_.Clear();
        capture_queue_.clear();
        capture_awaiting_ready_ = false;
        capture_awaiting_paint_ = false;
        capture_discard_next_paint_ = false;
        preparing_live_capture_ = false;
        selective_capture_ = false;
        BeginCapturePass();
        return;
    }

    if (mode_ == PipelineMode::Capturing
        && (capture_awaiting_ready_ || capture_awaiting_paint_)) {
        ++capture_wait_ticks_;
        if (capture_wait_ticks_ > kCaptureTimeoutTicks) {
            EnterFallback("capture_timeout");
        }
        return;
    }

    // New graph revision → recapture.
    if (snap->graph_revision != last_seen_revision_
        && mode_ != PipelineMode::Capturing) {
        cache_.Clear();
        BeginCapturePass();
        return;
    }

    if (mode_ == PipelineMode::Composing
        && snap->state_revision != last_seen_state_revision_) {
        BeginSelectiveCapture(*snap);
        return;
    }

    if (mode_ == PipelineMode::Disabled && enabled_) {
        BeginCapturePass();
        return;
    }

}

void LivePipeline::OnCaptureReady(uint64_t request_seq) {
    if (!enabled_ || mode_ != PipelineMode::Capturing
        || !capture_awaiting_ready_ || request_seq != capture_waiting_seq_) {
        return;
    }
    capture_awaiting_ready_ = false;
    capture_wait_ticks_ = 0;
    ++stats_.capture_ready_acks;
    capture_awaiting_paint_ = true;
    // A BeginFrame may already be in flight from the tick that delivered the
    // renderer ACK. Its OnPaint can still contain the previous capture host.
    // Discard it and accept only a paint driven by the next post-ACK tick.
    capture_discard_next_paint_ = true;
}

void LivePipeline::OnCaptureError(uint64_t request_seq) {
    if (enabled_ && mode_ == PipelineMode::Capturing
        && capture_awaiting_ready_
        && request_seq == capture_waiting_seq_) {
        EnterFallback("capture_host_error");
    }
}

PaintDisposition LivePipeline::OnPaint(const uint8_t* bgra, int width,
                                       int height, uint64_t paint_seq,
                                       std::span<const LayerDirtyRect> dirty_rects) {
    if (!enabled_ || mode_ == PipelineMode::Disabled
        || mode_ == PipelineMode::FallbackMonolith) {
        return PaintDisposition::ForwardToRing;
    }

    if (mode_ == PipelineMode::Capturing && capture_awaiting_paint_) {
        if (capture_discard_next_paint_) {
            capture_discard_next_paint_ = false;
            capture_wait_ticks_ = 0;
            return PaintDisposition::ConsumedByCapture;
        }
        if (!CaptureMarkerMatches(bgra, width, height, capture_waiting_seq_)) {
            return PaintDisposition::ConsumedByCapture;
        }
        if (preparing_live_capture_) {
            const ProtocolSnapshot* snap =
                store_ && store_->Current() ? store_->Current() : nullptr;
            const ProtocolLayerNode* layer = nullptr;
            if (snap) {
                const auto it = std::find_if(
                    snap->layers.begin(), snap->layers.end(),
                    [this](const auto& candidate) {
                        return candidate.id == live_layer_id_;
                    });
                if (it != snap->layers.end()) layer = &*it;
            }
            if (!layer) {
                EnterFallback("live_layer_missing:" + live_layer_id_);
                return PaintDisposition::ConsumedByCapture;
            }
            const int64_t required_w =
                static_cast<int64_t>(layer->source_w) + kCapturePadding * 2;
            const int64_t required_h =
                static_cast<int64_t>(layer->source_h) + kCapturePadding * 2;
            if (required_w > width || required_h > height) {
                EnterFallback("live_capture_extent:" + live_layer_id_);
                return PaintDisposition::ConsumedByCapture;
            }
            if (!cache_.PutCropped(
                    live_layer_id_, bgra, width, height,
                    static_cast<int32_t>(required_w),
                    static_cast<int32_t>(required_h), kCapturePadding,
                    paint_seq != 0 ? paint_seq : capture_request_seq_)) {
                EnterFallback("live_cache_rejected:" + live_layer_id_);
                return PaintDisposition::ConsumedByCapture;
            }
            cache_.ClearRect(live_layer_id_, 0, 0, 4, 4);
            ++live_update_generation_;
            stats_.cache_bytes = cache_.bytes();
            preparing_live_capture_ = false;
            capture_awaiting_paint_ = false;
            mode_ = PipelineMode::Composing;
            selective_capture_ = false;
            if (snap) {
                last_seen_revision_ = snap->graph_revision;
                last_seen_state_revision_ = snap->state_revision;
            }
            return PaintDisposition::ConsumedByCompose;
        }
        if (capture_index_ < capture_queue_.size()) {
            const std::string& id = capture_queue_[capture_index_];
            const ProtocolSnapshot* snap =
                store_ && store_->Current() ? store_->Current() : nullptr;
            const ProtocolLayerNode* layer = nullptr;
            if (snap) {
                const auto it = std::find_if(
                    snap->layers.begin(), snap->layers.end(),
                    [&id](const auto& candidate) {
                        return candidate.id == id;
                    });
                if (it != snap->layers.end()) layer = &*it;
            }
            if (!layer) {
                EnterFallback("capture_layer_missing:" + id);
                return PaintDisposition::ConsumedByCapture;
            }
            const int64_t required_w =
                static_cast<int64_t>(layer->source_w) + kCapturePadding * 2;
            const int64_t required_h =
                static_cast<int64_t>(layer->source_h) + kCapturePadding * 2;
            if (required_w > width || required_h > height) {
                EnterFallback("capture_extent:" + id);
                return PaintDisposition::ConsumedByCapture;
            }
            if (!cache_.PutCropped(
                    id, bgra, width, height,
                    static_cast<int32_t>(required_w),
                    static_cast<int32_t>(required_h), kCapturePadding,
                    paint_seq != 0 ? paint_seq : capture_waiting_seq_)) {
                EnterFallback("capture_cache_rejected:" + id);
                return PaintDisposition::ConsumedByCapture;
            }
            cache_.ClearRect(id, 0, 0, 4, 4);
            stats_.cache_bytes = cache_.bytes();
            if (selective_capture_
                && std::find(
                    pending_content_dirty_ids_.begin(),
                    pending_content_dirty_ids_.end(), id)
                    == pending_content_dirty_ids_.end()) {
                pending_content_dirty_ids_.push_back(id);
            }
            ++capture_index_;
            capture_awaiting_paint_ = false;
            AdvanceCapture();
            return PaintDisposition::ConsumedByCapture;
        }
    }
    if (mode_ == PipelineMode::Capturing) {
        // Ignore paints until the renderer-side ready acknowledgement proves
        // that the requested isolated host is active.
        return PaintDisposition::ConsumedByCapture;
    }

    if (mode_ == PipelineMode::Composing) {
        if (live_layer_id_.empty()) {
            return PaintDisposition::ConsumedByCapture;
        }
        const ProtocolSnapshot* snap =
            store_ && store_->Current() ? store_->Current() : nullptr;
        const ProtocolLayerNode* layer = nullptr;
        if (snap) {
            const auto it = std::find_if(
                snap->layers.begin(), snap->layers.end(),
                [this](const auto& candidate) {
                    return candidate.id == live_layer_id_;
                });
            if (it != snap->layers.end()) layer = &*it;
        }
        if (!layer) {
            EnterFallback("live_layer_missing:" + live_layer_id_);
            return PaintDisposition::ConsumedByCapture;
        }
        const int64_t required_w =
            static_cast<int64_t>(layer->source_w) + kCapturePadding * 2;
        const int64_t required_h =
            static_cast<int64_t>(layer->source_h) + kCapturePadding * 2;
        if (required_w > width || required_h > height) {
            EnterFallback("live_capture_extent:" + live_layer_id_);
            return PaintDisposition::ConsumedByCapture;
        }
        size_t copied_bytes = 0;
        if (!cache_.UpdateCropped(
                live_layer_id_, bgra, width, height,
                static_cast<int32_t>(required_w),
                static_cast<int32_t>(required_h), kCapturePadding,
                dirty_rects,
                paint_seq != 0 ? paint_seq : capture_request_seq_,
                &copied_bytes)) {
            EnterFallback("live_region_update_rejected:" + live_layer_id_);
            return PaintDisposition::ConsumedByCapture;
        }
        cache_.ClearRect(live_layer_id_, 0, 0, 4, 4);
        ++live_update_generation_;
        ++stats_.live_region_updates;
        stats_.live_region_bytes += copied_bytes;
        stats_.live_full_bytes +=
            static_cast<uint64_t>(required_w * required_h * 4);
        stats_.cache_bytes = cache_.bytes();
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

    for (const auto& layer : snap.layers) {
        if (layer.kind == ProtocolNodeKind::MaskOperator) continue;
        const LayerBitmap* bmp = cache_.Get(layer.id);
        if (!bmp) continue;

        LayerNode node;
        node.buffer.data = bmp->bgra.data();
        node.buffer.width = bmp->width;
        node.buffer.height = bmp->height;
        node.buffer.stride_bytes = 0;
        node.layout.source_w = bmp->width;
        node.layout.source_h = bmp->height;
        if (layer.has_affine) {
            LayerAffine affine{
                layer.affine[0], layer.affine[1], layer.affine[2],
                layer.affine[3], layer.affine[4], layer.affine[5],
            };
            affine.m02 -=
                (affine.m00 + affine.m01) * static_cast<float>(bmp->padding);
            affine.m12 -=
                (affine.m10 + affine.m11) * static_cast<float>(bmp->padding);
            node.layout.affine = affine;
        } else {
            node.layout.position_x =
                layer.layout_position.x - bmp->padding;
            node.layout.position_y =
                layer.layout_position.y - bmp->padding;
            node.layout.scale_x = layer.scale_x;
            node.layout.scale_y = layer.scale_y;
            node.layout.rotation_deg = layer.rotation_deg;
            node.layout.anchor_x = layer.anchor_x;
            node.layout.anchor_y = layer.anchor_y;
        }
        node.opacity = layer.opacity;
        for (const auto& mask : snap.layers) {
            if (mask.kind != ProtocolNodeKind::MaskOperator) continue;
            const bool affects = std::find(
                mask.affected_source_ids.begin(),
                mask.affected_source_ids.end(), layer.id)
                != mask.affected_source_ids.end();
            if (!affects) continue;
            MaskOp op;
            op.mode = mask.mask_mode == ProtocolMaskMode::Inverted
                ? MaskMode::Inverted
                : MaskMode::Normal;
            op.rect = {mask.mask_rect.x, mask.mask_rect.y,
                       mask.mask_rect.width, mask.mask_rect.height};
            node.masks.push_back(op);
        }
        out.layers.push_back(node);
    }
}

std::vector<LayerRect> LivePipeline::BuildDirtyRegions(
    const ProtocolSnapshot& previous, const ProtocolSnapshot& current,
    int32_t dst_w, int32_t dst_h) const {
    const LayerRect full{0, 0, dst_w, dst_h};
    if (dst_w <= 0 || dst_h <= 0
        || previous.graph_revision != current.graph_revision
        || previous.layers.size() != current.layers.size()) {
        return {full};
    }
    for (size_t i = 0; i < current.layers.size(); ++i) {
        if (previous.layers[i].id != current.layers[i].id
            || previous.layers[i].kind != current.layers[i].kind) {
            return {full};
        }
    }

    constexpr int32_t kTile = 64;
    const int32_t columns = (dst_w + kTile - 1) / kTile;
    const int32_t rows = (dst_h + kTile - 1) / kTile;
    std::vector<uint8_t> dirty(
        static_cast<size_t>(columns) * rows, 0);
    const auto mark = [&](const LayerRect& rect) {
        if (rect.width <= 0 || rect.height <= 0) return;
        const int64_t right =
            static_cast<int64_t>(rect.x) + rect.width;
        const int64_t bottom =
            static_cast<int64_t>(rect.y) + rect.height;
        const int32_t left = std::clamp(rect.x, 0, dst_w);
        const int32_t top = std::clamp(rect.y, 0, dst_h);
        const int32_t clipped_right = static_cast<int32_t>(
            std::clamp<int64_t>(right, 0, dst_w));
        const int32_t clipped_bottom = static_cast<int32_t>(
            std::clamp<int64_t>(bottom, 0, dst_h));
        if (left >= clipped_right || top >= clipped_bottom) return;
        const int32_t tile_x0 = left / kTile;
        const int32_t tile_y0 = top / kTile;
        const int32_t tile_x1 = (clipped_right - 1) / kTile;
        const int32_t tile_y1 = (clipped_bottom - 1) / kTile;
        for (int32_t y = tile_y0; y <= tile_y1; ++y) {
            for (int32_t x = tile_x0; x <= tile_x1; ++x) {
                dirty[static_cast<size_t>(y) * columns + x] = 1;
            }
        }
    };

    MixInput previous_input;
    MixInput current_input;
    BuildMixInputFromCache(previous_input, previous);
    BuildMixInputFromCache(current_input, current);
    const auto mark_layer = [&](const ProtocolSnapshot& snapshot,
                                const MixInput& input,
                                const std::string& id) {
        const LayerNode* node = FindMixLayer(snapshot, input, id);
        if (!node) {
            mark(full);
            return;
        }
        const AffineMapping mapping = BuildAffineMapping(node->layout);
        if (!mapping.supported) {
            mark(full);
            return;
        }
        mark({
            mapping.dest_x, mapping.dest_y,
            mapping.dest_w, mapping.dest_h,
        });
    };

    const bool state_changed =
        previous.state_revision != current.state_revision;
    for (const auto& layer : current.layers) {
        const ProtocolLayerNode* old =
            FindProtocolLayer(previous, layer.id);
        if (!old) return {full};
        if (layer.kind == ProtocolNodeKind::MaskOperator) {
            if (SameMaskVisualState(*old, layer)) continue;
            const bool broad_change =
                old->mask_mode != layer.mask_mode
                || old->affected_source_ids != layer.affected_source_ids
                || old->mask_rect.width <= 0 || old->mask_rect.height <= 0
                || layer.mask_rect.width <= 0 || layer.mask_rect.height <= 0;
            if (broad_change) {
                for (const auto& id : old->affected_source_ids) {
                    mark_layer(previous, previous_input, id);
                }
                for (const auto& id : layer.affected_source_ids) {
                    mark_layer(current, current_input, id);
                }
            } else {
                mark({
                    old->mask_rect.x, old->mask_rect.y,
                    old->mask_rect.width, old->mask_rect.height,
                });
                mark({
                    layer.mask_rect.x, layer.mask_rect.y,
                    layer.mask_rect.width, layer.mask_rect.height,
                });
            }
            continue;
        }

        const bool content_changed = (
            state_changed
            && std::find(
                   current.invalidated_layer_ids.begin(),
                   current.invalidated_layer_ids.end(), layer.id)
                != current.invalidated_layer_ids.end())
            || std::find(
                pending_content_dirty_ids_.begin(),
                pending_content_dirty_ids_.end(), layer.id)
                != pending_content_dirty_ids_.end();
        const bool live_changed =
            layer.kind == ProtocolNodeKind::LiveHtml
            && live_update_generation_
                != last_composed_live_update_generation_;
        if (!SamePixelVisualState(*old, layer)
            || content_changed || live_changed) {
            mark_layer(previous, previous_input, layer.id);
            mark_layer(current, current_input, layer.id);
        }
    }

    const size_t dirty_tiles = static_cast<size_t>(
        std::count(dirty.begin(), dirty.end(), uint8_t{1}));
    if (dirty_tiles == 0) return {};
    if (dirty_tiles * 10 >= dirty.size() * 6) return {full};

    std::vector<LayerRect> regions;
    for (int32_t tile_y = 0; tile_y < rows; ++tile_y) {
        int32_t tile_x = 0;
        while (tile_x < columns) {
            while (tile_x < columns
                   && dirty[static_cast<size_t>(tile_y) * columns + tile_x]
                       == 0) {
                ++tile_x;
            }
            const int32_t begin = tile_x;
            while (tile_x < columns
                   && dirty[static_cast<size_t>(tile_y) * columns + tile_x]
                       != 0) {
                ++tile_x;
            }
            if (begin == tile_x) continue;
            const int32_t x = begin * kTile;
            const int32_t y = tile_y * kTile;
            regions.push_back({
                x, y, std::min(dst_w, tile_x * kTile) - x,
                std::min(dst_h, y + kTile) - y,
            });
        }
    }
    return regions;
}

bool LivePipeline::ComposeInto(uint8_t* dst, int32_t dst_w, int32_t dst_h) {
    return ComposeInternal(dst, dst_w, dst_h, false);
}

bool LivePipeline::ComposeIncrementalInto(
    uint8_t* dst, int32_t dst_w, int32_t dst_h) {
    return ComposeInternal(dst, dst_w, dst_h, true);
}

bool LivePipeline::ComposeInternal(
    uint8_t* dst, int32_t dst_w, int32_t dst_h, bool incremental) {
    if (!enabled_ || !PrefersComposedOutput() || !store_
        || !store_->HasSnapshot()) {
        return false;
    }
    const ProtocolSnapshot* snap = store_->Current();
    if (!snap) return false;

    // Require every pixel-bearing layer to be present. Live sources are
    // refreshed by the immediately preceding OnPaint.
    for (const auto& layer : snap->layers) {
        if (layer.kind == ProtocolNodeKind::MaskOperator) continue;
        if (!cache_.Has(layer.id)) {
            EnterFallback("missing_cache:" + layer.id);
            return false;
        }
    }

    MixInput input;
    BuildMixInputFromCache(input, *snap);
    input.canvas_width = dst_w;
    input.canvas_height = dst_h;

    SyntheticSnapshot synth;
    synth.input = input;
    // Bitmaps are owned by cache_; synth.bitmaps stays empty (MixInput holds
    // raw pointers into the cache).
    if (!dst || dst_w <= 0 || dst_h <= 0) return false;
    const auto reasons = compositor_.mixer().FallbackReasons(input);
    if (!reasons.empty()) {
        EnterFallback(FallbackReasonLabel(reasons.front()));
        return false;
    }

    bool full_compose = !incremental
        || !last_incremental_snapshot_.has_value()
        || last_incremental_width_ != dst_w
        || last_incremental_height_ != dst_h;
    std::vector<LayerRect> regions;
    if (!full_compose) {
        regions = BuildDirtyRegions(
            *last_incremental_snapshot_, *snap, dst_w, dst_h);
        full_compose = regions.size() == 1
            && regions[0].x == 0 && regions[0].y == 0
            && regions[0].width == dst_w && regions[0].height == dst_h;
    }

    CompositeResult res;
    if (full_compose) {
        std::memset(
            dst, 0, static_cast<size_t>(dst_w) * dst_h * 4);
        res = compositor_.Composite(synth, dst_w, dst_h, dst);
        ++stats_.full_composes;
    } else {
        ++stats_.incremental_frames;
        stats_.incremental_tiles += regions.size();
        if (regions.empty()) {
            res.ok = true;
        } else {
            for (const auto& region : regions) {
                for (int32_t y = region.y;
                     y < region.y + region.height; ++y) {
                    std::memset(
                        dst
                            + (static_cast<size_t>(y) * dst_w + region.x) * 4,
                        0, static_cast<size_t>(region.width) * 4);
                }
            }
            res = compositor_.CompositeRegions(
                synth, dst_w, dst_h, dst, regions);
        }
    }
    if (!res.ok) {
        stats_.last_fallback_reason = res.fallback_reasons.empty()
            ? "mixer_unsupported"
            : res.fallback_reasons.front();
        EnterFallback(stats_.last_fallback_reason);
        return false;
    }
    stats_.last_compose_ns = res.compose_ns;
    compose_latency_ns_[compose_latency_next_] = res.compose_ns;
    compose_latency_next_ =
        (compose_latency_next_ + 1) % compose_latency_ns_.size();
    compose_latency_count_ = std::min(
        compose_latency_count_ + 1, compose_latency_ns_.size());

    if (incremental) {
        last_incremental_snapshot_ = *snap;
        last_composed_live_update_generation_ = live_update_generation_;
        last_incremental_width_ = dst_w;
        last_incremental_height_ = dst_h;
        pending_content_dirty_ids_.clear();
    }
    last_composed_graph_revision_ = snap->graph_revision;
    last_composed_state_revision_ = snap->state_revision;
    ++compose_seq_;
    ++stats_.composed_frames;
    return true;
}

}  // namespace bg::compositor
