// engine/src/compositor/live_pipeline.h
//
// Doc02 PR5 full-path layered compositor orchestrator.
//
// Lifecycle:
//   1. Attach(graph_store, browser, canvas_w, canvas_h).
//   2. On each pump tick, call Tick(paint_buffer?) — either consumes a CEF
//      OnPaint redirected into the capture path, or composes from cache.
//   3. When a composed frame is ready, Publish() copies it into FrameRing.
//
// Capture strategy (single CEF browser, visibility-filter isolation):
//   - After a supported graph snapshot arrives, capture each cacheable layer
//     by asking the page to show only that layer, BeginFrame, wait for OnPaint.
//   - Each frame with live_html layers: show only live layers, BeginFrame,
//     store the painted canvas as the live overlay, then Mix(cached sources +
//     live overlay regions) into the output.
//
// Fallback: any unsupported operator, empty cache, or capture timeout returns
// control to the legacy monolith OnPaint path for that frame.

#ifndef BG_ENGINE_COMPOSITOR_LIVE_PIPELINE_H
#define BG_ENGINE_COMPOSITOR_LIVE_PIPELINE_H

#include "layer_bitmap_cache.h"
#include "layered_compositor.h"
#include "mixer/protocol_types.h"
#include "mixer/render_graph_store.h"

#include "include/cef_browser.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace bg::compositor {

enum class PipelineMode : uint8_t {
    Disabled,          // flag off — never intercept OnPaint
    Capturing,         // mid per-layer capture sequence
    Composing,         // cache warm; compose each frame
    FallbackMonolith,  // permanently fall back until next take/snapshot
};

enum class PaintDisposition : uint8_t {
    ForwardToRing,     // caller should deliver this paint to FrameRing as usual
    ConsumedByCapture, // paint was a snapshot; do not deliver to FrameRing
    ConsumedByCompose, // paint was a live overlay; pipeline will publish itself
};

struct PipelineStats {
    uint64_t composed_frames = 0;
    uint64_t fallback_frames = 0;
    uint64_t capture_passes = 0;
    uint64_t capture_failures = 0;
    uint64_t capture_ready_acks = 0;
    uint64_t reused_live_frames = 0;
    uint64_t live_region_updates = 0;
    uint64_t live_region_bytes = 0;
    uint64_t live_full_bytes = 0;
    uint64_t incremental_frames = 0;
    uint64_t incremental_tiles = 0;
    uint64_t full_composes = 0;
    size_t cache_bytes = 0;
    int64_t last_compose_ns = 0;
    std::string last_fallback_reason;
};

struct PipelineProvenanceSnapshot {
    PipelineMode mode = PipelineMode::Disabled;
    uint64_t graph_revision = 0;
    uint64_t state_revision = 0;
    uint64_t compose_seq = 0;
    uint64_t live_update_generation = 0;
};

class LivePipeline {
  public:
    LivePipeline() = default;

    void Attach(RenderGraphStore* store, int32_t canvas_w, int32_t canvas_h);
    void set_browser(CefRefPtr<CefBrowser> browser) { browser_ = browser; }
    void set_template_id(std::string id) { template_id_ = std::move(id); }
    void set_template_allowlist(std::vector<std::string> ids) {
        template_allowlist_ = std::move(ids);
    }

    PipelineMode mode() const { return mode_; }
    const PipelineStats& stats() const { return stats_; }
    PipelineProvenanceSnapshot provenance_snapshot() const {
        return {
            .mode = mode_,
            .graph_revision = last_composed_graph_revision_,
            .state_revision = last_composed_state_revision_,
            .compose_seq = compose_seq_,
            .live_update_generation = live_update_generation_,
        };
    }
    uint64_t ComposeLatencyPercentileUs(uint32_t percentile) const;
    bool enabled() const { return enabled_; }
    void set_enabled(bool on);

    // Called from OnPaint. Returns whether the caller should forward the
    // buffer to FrameRing. When the pipeline is capturing or composing live
    // overlays, the paint is consumed here.
    PaintDisposition OnPaint(const uint8_t* bgra, int width, int height,
                             uint64_t paint_seq,
                             std::span<const LayerDirtyRect> dirty_rects = {});

    // Renderer-side acknowledgement that the isolated capture host is ready.
    void OnCaptureReady(uint64_t request_seq);
    void OnCaptureError(uint64_t request_seq);

    // Called once per pump tick before BeginFrame. Starts a capture pass when
    // a new supported graph snapshot is available and the cache is cold.
    // Returns true when the pipeline wants to drive BeginFrame itself (e.g.
    // during capture); the caller should still SendExternalBeginFrame.
    void OnTick();

    // Compose the current cache (+ optional live overlay) into `dst`. Returns
    // true when a composed frame was written. On false the caller must use the
    // legacy monolith path.
    bool ComposeInto(uint8_t* dst, int32_t dst_w, int32_t dst_h);
    bool ComposeIncrementalInto(uint8_t* dst, int32_t dst_w, int32_t dst_h);

    // True when the next FrameRing publish should come from ComposeInto rather
    // than from the raw OnPaint buffer.
    bool PrefersComposedOutput() const {
        return mode_ == PipelineMode::Composing
            || (mode_ == PipelineMode::Capturing && selective_capture_);
    }

    // True when the current graph has live_html layers that require a CEF
    // BeginFrame/OnPaint each tick before ComposeInto can run.
    bool NeedsLivePaint() const;
    bool HasReusableLiveFrame() const {
        return PrefersComposedOutput() && !live_layer_id_.empty()
            && cache_.Has(live_layer_id_);
    }
    void RecordReusedLiveFrame() { ++stats_.reused_live_frames; }

  private:
    void BeginCapturePass();
    void BeginSelectiveCapture(const ProtocolSnapshot& snap);
    void AdvanceCapture();
    void RequestLayerCapture(const std::string& id);
    void ClearCaptureMode();
    void EnterFallback(std::string reason);
    bool GraphIsSupported(const ProtocolSnapshot& snap) const;
    bool TemplateIsAllowed(const ProtocolSnapshot& snap) const;
    std::vector<std::string> CacheableLayerIds(const ProtocolSnapshot& snap) const;
    std::vector<std::string> LiveLayerIds(const ProtocolSnapshot& snap) const;
    void BuildMixInputFromCache(MixInput& out, const ProtocolSnapshot& snap) const;
    bool ComposeInternal(uint8_t* dst, int32_t dst_w, int32_t dst_h,
                         bool incremental);
    std::vector<LayerRect> BuildDirtyRegions(
        const ProtocolSnapshot& previous, const ProtocolSnapshot& current,
        int32_t dst_w, int32_t dst_h) const;

    bool enabled_ = false;
    PipelineMode mode_ = PipelineMode::Disabled;
    RenderGraphStore* store_ = nullptr;
    CefRefPtr<CefBrowser> browser_;
    std::string template_id_ = "default";
    std::vector<std::string> template_allowlist_;
    int32_t canvas_w_ = 0;
    int32_t canvas_h_ = 0;

    LayerBitmapCache cache_;
    LayeredCompositor compositor_;
    PipelineStats stats_;
    static constexpr size_t kComposeLatencySamples = 512;
    std::array<int64_t, kComposeLatencySamples> compose_latency_ns_{};
    size_t compose_latency_count_ = 0;
    size_t compose_latency_next_ = 0;
    std::optional<ProtocolSnapshot> last_incremental_snapshot_;
    std::vector<std::string> pending_content_dirty_ids_;
    uint64_t live_update_generation_ = 0;
    uint64_t last_composed_live_update_generation_ = 0;
    uint64_t last_composed_graph_revision_ = 0;
    uint64_t last_composed_state_revision_ = 0;
    uint64_t compose_seq_ = 0;
    int32_t last_incremental_width_ = 0;
    int32_t last_incremental_height_ = 0;

    // Capture state machine.
    std::vector<std::string> capture_queue_;
    size_t capture_index_ = 0;
    uint64_t capture_waiting_seq_ = 0;
    uint64_t capture_request_seq_ = 0;
    uint32_t capture_wait_ticks_ = 0;
    bool capture_awaiting_ready_ = false;
    bool capture_awaiting_paint_ = false;
    bool capture_discard_next_paint_ = false;
    bool preparing_live_capture_ = false;
    bool selective_capture_ = false;
    uint64_t capture_graph_revision_ = 0;
    uint64_t capture_state_revision_ = 0;
    uint64_t last_seen_revision_ = 0;
    uint64_t last_seen_state_revision_ = 0;
    std::string live_layer_id_;
    bool fallback_retry_on_state_ = true;

    static constexpr int32_t kCapturePadding = 32;
    static constexpr uint32_t kCaptureTimeoutTicks = 100;
};

}  // namespace bg::compositor

#endif  // BG_ENGINE_COMPOSITOR_LIVE_PIPELINE_H
