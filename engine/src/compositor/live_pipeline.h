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

#include <cstdint>
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
    int64_t last_compose_ns = 0;
    std::string last_fallback_reason;
};

class LivePipeline {
  public:
    LivePipeline() = default;

    void Attach(RenderGraphStore* store, int32_t canvas_w, int32_t canvas_h);
    void set_browser(CefRefPtr<CefBrowser> browser) { browser_ = browser; }
    void set_template_id(std::string id) { template_id_ = std::move(id); }

    PipelineMode mode() const { return mode_; }
    const PipelineStats& stats() const { return stats_; }
    bool enabled() const { return enabled_; }
    void set_enabled(bool on);

    // Called from OnPaint. Returns whether the caller should forward the
    // buffer to FrameRing. When the pipeline is capturing or composing live
    // overlays, the paint is consumed here.
    PaintDisposition OnPaint(const uint8_t* bgra, int width, int height,
                             uint64_t paint_seq);

    // Called once per pump tick before BeginFrame. Starts a capture pass when
    // a new supported graph snapshot is available and the cache is cold.
    // Returns true when the pipeline wants to drive BeginFrame itself (e.g.
    // during capture); the caller should still SendExternalBeginFrame.
    void OnTick();

    // Compose the current cache (+ optional live overlay) into `dst`. Returns
    // true when a composed frame was written. On false the caller must use the
    // legacy monolith path.
    bool ComposeInto(uint8_t* dst, int32_t dst_w, int32_t dst_h);

    // True when the next FrameRing publish should come from ComposeInto rather
    // than from the raw OnPaint buffer.
    bool PrefersComposedOutput() const {
        return mode_ == PipelineMode::Composing;
    }

    // True when the current graph has live_html layers that require a CEF
    // BeginFrame/OnPaint each tick before ComposeInto can run.
    bool NeedsLivePaint() const;

  private:
    void BeginCapturePass();
    void AdvanceCapture();
    void RequestVisibilityFilter(const std::vector<std::string>& ids);
    void ClearVisibilityFilter();
    bool GraphIsSupported(const ProtocolSnapshot& snap) const;
    std::vector<std::string> CacheableLayerIds(const ProtocolSnapshot& snap) const;
    std::vector<std::string> LiveLayerIds(const ProtocolSnapshot& snap) const;
    void BuildMixInputFromCache(MixInput& out, const ProtocolSnapshot& snap) const;

    bool enabled_ = false;
    PipelineMode mode_ = PipelineMode::Disabled;
    RenderGraphStore* store_ = nullptr;
    CefRefPtr<CefBrowser> browser_;
    std::string template_id_ = "default";
    int32_t canvas_w_ = 0;
    int32_t canvas_h_ = 0;

    LayerBitmapCache cache_;
    LayeredCompositor compositor_;
    PipelineStats stats_;

    // Capture state machine.
    std::vector<std::string> capture_queue_;
    size_t capture_index_ = 0;
    uint64_t capture_waiting_seq_ = 0;
    bool capture_awaiting_paint_ = false;
    uint64_t last_seen_revision_ = 0;

    // Live overlay from the most recent live-only paint (full canvas, mostly
    // transparent except the live layers).
    std::vector<uint8_t> live_overlay_;
    bool have_live_overlay_ = false;
};

}  // namespace bg::compositor

#endif  // BG_ENGINE_COMPOSITOR_LIVE_PIPELINE_H
