// engine/tests/test_live_pipeline.cpp
//
// Unit tests for LayerBitmapCache and LivePipeline graph-support helpers
// that do not require CEF.

#include "../src/compositor/layer_bitmap_cache.h"
#include "../src/compositor/live_pipeline.h"
#include "../src/frame_ring.h"
#include "../src/mixer/protocol_types.h"
#include "../src/mixer/render_graph_store.h"

#include <cstdio>
#include <cmath>
#include <cstring>
#include <vector>

namespace {

int g_failures = 0;

struct TestEntry {
    const char* name;
    void (*fn)();
};

std::vector<TestEntry>& Registry() {
    static std::vector<TestEntry> v;
    return v;
}

struct Registrar {
    Registrar(const char* name, void (*fn)()) {
        Registry().push_back({name, fn});
    }
};

#define TEST(name)                                                              \
    static void name();                                                         \
    static Registrar g_reg_##name(#name, name);                                 \
    static void name()

#define FAIL(msg)                                                               \
    do {                                                                        \
        std::fprintf(stderr, "  FAIL: %s\n", msg);                              \
        ++g_failures;                                                           \
        return;                                                                 \
    } while (0)

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (!(cond)) FAIL(msg);                                                 \
    } while (0)

void StampCaptureMarker(std::vector<uint8_t>& bgra, int width,
                        uint64_t capture_seq) {
    const auto stamp = [&](int left, int shift, int y) {
        const uint64_t value = capture_seq >> shift;
        const uint8_t red = static_cast<uint8_t>(value & 0xFF);
        const uint8_t green = static_cast<uint8_t>((value >> 8) & 0xFF);
        const uint8_t blue = static_cast<uint8_t>((value >> 16) & 0xFF);
        for (int x = left; x < left + 2; ++x) {
            uint8_t* pixel = bgra.data() + (y * width + x) * 4;
            pixel[0] = blue;
            pixel[1] = green;
            pixel[2] = red;
            pixel[3] = 0xFF;
        }
    };
    for (int y = 0; y < 4; ++y) {
        stamp(0, 0, y);
        stamp(2, 24, y);
    }
}

void StampCaptureMarkerTopRow(std::vector<uint8_t>& bgra, int width,
                              uint64_t capture_seq) {
    const auto stamp = [&](int left, int shift) {
        const uint64_t value = capture_seq >> shift;
        const uint8_t red = static_cast<uint8_t>(value & 0xFF);
        const uint8_t green = static_cast<uint8_t>((value >> 8) & 0xFF);
        const uint8_t blue = static_cast<uint8_t>((value >> 16) & 0xFF);
        for (int x = left; x < left + 2; ++x) {
            uint8_t* pixel = bgra.data() + x * 4;
            pixel[0] = blue;
            pixel[1] = green;
            pixel[2] = red;
            pixel[3] = 0xFF;
        }
    };
    stamp(0, 0);
    stamp(2, 24);
}

}  // namespace

TEST(LayerBitmapCacheStoresAndRetrieves) {
    bg::compositor::LayerBitmapCache cache;
    std::vector<uint8_t> px(4 * 4 * 4, 0xAB);
    cache.Put("a", px.data(), 4, 4, 7);
    const auto* got = cache.Get("a");
    CHECK(got != nullptr, "missing entry");
    CHECK(got->width == 4, "width");
    CHECK(got->height == 4, "height");
    CHECK(got->capture_seq == 7u, "seq");
    CHECK(got->bgra.size() == px.size(), "bytes");
    CHECK(got->bgra[0] == 0xAB, "pixel");
    CHECK(cache.Get("missing") == nullptr, "unknown should be null");
}

TEST(LayerBitmapCacheReplaceOverwrites) {
    bg::compositor::LayerBitmapCache cache;
    std::vector<uint8_t> a(4, 1);
    std::vector<uint8_t> b(4, 2);
    cache.Put("x", a.data(), 1, 1, 1);
    cache.Put("x", b.data(), 1, 1, 2);
    CHECK(cache.Get("x")->bgra[0] == 2, "replace failed");
    CHECK(cache.Get("x")->capture_seq == 2u, "seq not updated");
}

TEST(LayerBitmapCacheCropsAndEnforcesBound) {
    bg::compositor::LayerBitmapCache cache(32);
    std::vector<uint8_t> canvas(4 * 2 * 4, 0);
    for (size_t i = 0; i < canvas.size(); ++i) {
        canvas[i] = static_cast<uint8_t>(i);
    }
    CHECK(cache.PutCropped("a", canvas.data(), 4, 2, 2, 2, 1, 1),
          "tight crop rejected");
    const auto* crop = cache.Get("a");
    CHECK(crop != nullptr, "crop missing");
    CHECK(crop->width == 2 && crop->height == 2, "crop dimensions");
    CHECK(crop->padding == 1, "crop padding");
    CHECK(crop->bgra[0] == canvas[0], "first crop byte");
    CHECK(crop->bgra[8] == canvas[16], "second crop row");
    CHECK(cache.bytes() == 16u, "cache byte accounting");

    std::vector<uint8_t> other(4 * 4, 7);
    CHECK(cache.Put("b", other.data(), 2, 2, 2), "second entry rejected");
    CHECK(cache.bytes() == 32u, "cache bound accounting");
    CHECK(!cache.Put("oversized", other.data(), 5, 2, 3),
          "oversized entry accepted");
    CHECK(cache.bytes() <= cache.max_bytes(), "cache exceeded byte cap");
}

TEST(LayerBitmapCacheUpdatesOnlyDirtyCropRegions) {
    bg::compositor::LayerBitmapCache cache;
    std::vector<uint8_t> initial(6 * 4 * 4, 0x11);
    CHECK(cache.PutCropped("live", initial.data(), 6, 4, 4, 3, 1, 1),
          "initial live crop rejected");
    std::vector<uint8_t> next(6 * 4 * 4, 0x77);
    const std::vector<bg::compositor::LayerDirtyRect> dirty = {
        {1, 1, 2, 1},
        {5, 0, 1, 4},  // Outside the tight 4-pixel crop.
    };
    size_t copied = 0;
    CHECK(cache.UpdateCropped(
              "live", next.data(), 6, 4, 4, 3, 1, dirty, 2, &copied),
          "dirty live crop update rejected");
    const auto* bitmap = cache.Get("live");
    CHECK(bitmap != nullptr, "updated live crop missing");
    CHECK(copied == 8u, "dirty update copied more than intersected region");
    CHECK(bitmap->capture_seq == 2u, "dirty update sequence not recorded");
    for (int32_t y = 0; y < 3; ++y) {
        for (int32_t x = 0; x < 4; ++x) {
            const uint8_t expected =
                (y == 1 && x >= 1 && x < 3) ? 0x77 : 0x11;
            CHECK(bitmap->bgra[(y * 4 + x) * 4] == expected,
                  "dirty update modified the wrong crop pixel");
        }
    }
}

TEST(LayerBitmapCacheNeverEvictsPinnedSnapshotLayers) {
    bg::compositor::LayerBitmapCache cache(32);
    std::vector<uint8_t> pixels(16, 7);
    CHECK(cache.Put("a", pixels.data(), 2, 2, 1), "put a");
    CHECK(cache.Put("b", pixels.data(), 2, 2, 2), "put b");
    cache.SetPinnedLayerIds({"a", "b"});
    std::vector<uint8_t> small(4, 9);
    CHECK(!cache.Put("c", small.data(), 1, 1, 3),
          "cache admitted a layer by evicting a pinned snapshot");
    CHECK(cache.Has("a") && cache.Has("b"),
          "failed insert modified pinned cache state");
    CHECK(cache.Put("a", pixels.data(), 2, 2, 4),
          "replacement of the same pinned layer failed");
    cache.SetPinnedLayerIds({"a"});
    CHECK(cache.Put("c", pixels.data(), 2, 2, 5),
          "unpinned LRU was not evicted");
    CHECK(cache.Has("a") && cache.Has("c") && !cache.Has("b"),
          "pin-aware eviction chose the wrong layer");
}

TEST(FrameRingProduceSwapsOwnedBufferOnlyOnSuccess) {
    bg::FrameRing ring;
    std::vector<uint8_t> first(8, 1);
    ring.Copy(first.data(), 2, 1);
    CHECK(!ring.Produce(2, 1, [](uint8_t* dst) {
              std::memset(dst, 2, 8);
              return false;
          }),
          "failed producer write was published");
    ring.Latest([](const bg::Frame& frame) {
        CHECK(frame.bgra[0] == 1, "failed producer corrupted latest frame");
    });
    CHECK(ring.Produce(2, 1, [](uint8_t* dst) {
              std::memset(dst, 3, 8);
              return true;
          }),
          "successful producer write was rejected");
    ring.Latest([](const bg::Frame& frame) {
        CHECK(frame.bgra[0] == 3, "successful producer was not swapped");
    });
    CHECK(ring.UpdateLatest(2, 1, [](uint8_t* dst) {
              dst[4] = 9;
              return true;
          }),
          "incremental latest-buffer update failed");
    ring.Latest([](const bg::Frame& frame) {
        CHECK(frame.bgra[0] == 3 && frame.bgra[4] == 9,
              "incremental update did not preserve clean bytes");
    });
}

TEST(LivePipelineDisabledForwardsNothingUntilEnabled) {
    bg::RenderGraphStore store;
    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 8, 8);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Disabled, "default mode");
    CHECK(!pipe.PrefersComposedOutput(), "disabled should not prefer compose");
    auto d = pipe.OnPaint(nullptr, 8, 8, 1);
    CHECK(d == bg::compositor::PaintDisposition::ForwardToRing,
          "disabled OnPaint should forward");
}

TEST(LivePipelineEnableStartsCaptureOnTickWithSnapshot) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snap;
    snap.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 8;
    layer.source_h = 8;
    snap.layers.push_back(layer);
    store.Commit(std::move(snap));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 8, 8);
    pipe.set_enabled(true);
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Capturing
              || pipe.mode() == bg::compositor::PipelineMode::Composing,
          "enabled tick should enter capture or compose");
}

TEST(LivePipelineFractionalRotationStartsCapture) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snap;
    snap.graph_revision = 2;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 8;
    layer.source_h = 8;
    layer.rotation_deg = 17.5f;
    snap.layers.push_back(layer);
    store.Commit(std::move(snap));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 8, 8);
    pipe.set_enabled(true);
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Capturing,
          "finite fractional rotation must be supported");
}

TEST(LivePipelineNonFiniteGraphFallsBack) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snap;
    snap.graph_revision = 3;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 8;
    layer.source_h = 8;
    layer.rotation_deg = std::nanf("");
    snap.layers.push_back(layer);
    store.Commit(std::move(snap));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 8, 8);
    pipe.set_enabled(true);
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::FallbackMonolith,
          "non-finite graph must fall back");
}

TEST(LivePipelineAllowlistRejectsUnknownTemplate) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snap;
    snap.template_id = "unknown";
    snap.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 8;
    layer.source_h = 8;
    snap.layers.push_back(layer);
    store.Commit(std::move(snap));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 8, 8);
    pipe.set_template_allowlist({"allowed"});
    pipe.set_enabled(true);
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::FallbackMonolith,
          "unknown template bypassed layered allowlist");
    CHECK(pipe.stats().last_fallback_reason
              == "template_not_allowlisted:unknown",
          "allowlist fallback reason mismatch");
    bg::ProtocolSnapshot animated = *store.Current();
    animated.state_revision = 1;
    animated.layers[0].opacity = 0.5f;
    store.Commit(std::move(animated));
    pipe.OnTick();
    CHECK(pipe.stats().fallback_frames == 1,
          "allowlist rejection retried on every state frame");
}

TEST(LivePipelineRecoversOnNewSupportedGraphRevision) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot empty;
    empty.graph_revision = 1;
    store.Commit(std::move(empty));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 8, 8);
    pipe.set_enabled(true);
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::FallbackMonolith,
          "empty graph should enter fallback");

    bg::ProtocolSnapshot supported;
    supported.graph_revision = 2;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 8;
    layer.source_h = 8;
    supported.layers.push_back(layer);
    store.Commit(std::move(supported));

    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Capturing,
          "new supported take must recover from prior fallback");
}

TEST(LivePipelineDiscardsPaintThatWasInFlightBeforeReady) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snap;
    snap.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 1;
    layer.source_h = 1;
    snap.layers.push_back(layer);
    store.Commit(std::move(snap));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    pipe.OnCaptureReady(1);

    std::vector<uint8_t> stale(65 * 65 * 4, 0x11);
    CHECK(pipe.OnPaint(stale.data(), 65, 65, 1)
              == bg::compositor::PaintDisposition::ConsumedByCapture,
          "stale paint disposition");
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Capturing,
          "in-flight paint must not complete capture");

    std::vector<uint8_t> fresh(65 * 65 * 4, 0x22);
    StampCaptureMarker(fresh, 65, 1);
    CHECK(pipe.OnPaint(fresh.data(), 65, 65, 2)
              == bg::compositor::PaintDisposition::ConsumedByCapture,
          "fresh capture disposition");
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "post-ready paint should complete capture");
    std::vector<uint8_t> composed(65 * 65 * 4);
    CHECK(pipe.ComposeInto(composed.data(), 65, 65),
          "captured layer did not compose");
    CHECK(pipe.ComposeLatencyPercentileUs(95)
              == static_cast<uint64_t>(pipe.stats().last_compose_ns / 1000),
          "compose percentile telemetry did not record first sample");
}

TEST(LivePipelineValidatesCaptureMarkerAtItsAnchoredTopRow) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snap;
    snap.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 1;
    layer.source_h = 1;
    snap.layers.push_back(layer);
    store.Commit(std::move(snap));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    pipe.OnCaptureReady(1);

    std::vector<uint8_t> pixels(65 * 65 * 4, 0x22);
    pipe.OnPaint(pixels.data(), 65, 65, 1);
    StampCaptureMarkerTopRow(pixels, 65, 1);
    pipe.OnPaint(pixels.data(), 65, 65, 2);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "top-anchored marker was validated from the wrong scanline");
}

TEST(LivePipelineCanReuseLastVerifiedLiveBitmap) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snapshot;
    snapshot.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "clock";
    layer.kind = bg::ProtocolNodeKind::LiveHtml;
    layer.source_w = 1;
    layer.source_h = 1;
    snapshot.layers.push_back(layer);
    store.Commit(std::move(snapshot));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    pipe.OnCaptureReady(1);
    std::vector<uint8_t> pixels(65 * 65 * 4, 0x44);
    pipe.OnPaint(pixels.data(), 65, 65, 1);
    StampCaptureMarker(pixels, 65, 1);
    pipe.OnPaint(pixels.data(), 65, 65, 2);
    CHECK(pipe.NeedsLivePaint(), "live graph must request a fresh CEF paint");
    CHECK(pipe.HasReusableLiveFrame(), "verified live bitmap is not reusable");
    pipe.OnCaptureError(1);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "late capture error knocked composing pipeline into fallback");
    std::vector<uint8_t> output(65 * 65 * 4);
    CHECK(pipe.ComposeInto(output.data(), 65, 65),
          "first live compose failed");
    CHECK(pipe.ComposeInto(output.data(), 65, 65),
          "stale-live reuse compose failed");
    pipe.RecordReusedLiveFrame();
    CHECK(pipe.stats().reused_live_frames == 1,
          "live reuse telemetry not recorded");
}

TEST(LivePipelineClearsLiveIdentityWhenReplacementGraphIsCacheOnly) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot initial;
    initial.graph_revision = 1;
    bg::ProtocolLayerNode live;
    live.id = "clock";
    live.kind = bg::ProtocolNodeKind::LiveHtml;
    live.source_w = 1;
    live.source_h = 1;
    initial.layers.push_back(live);
    store.Commit(std::move(initial));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    pipe.OnCaptureReady(1);
    std::vector<uint8_t> pixels(65 * 65 * 4, 0x44);
    pipe.OnPaint(pixels.data(), 65, 65, 1);
    StampCaptureMarker(pixels, 65, 1);
    pipe.OnPaint(pixels.data(), 65, 65, 2);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "initial live capture failed");

    bg::ProtocolSnapshot replacement;
    replacement.graph_revision = 2;
    bg::ProtocolLayerNode cached;
    cached.id = "static";
    cached.kind = bg::ProtocolNodeKind::CachedBitmap;
    cached.source_w = 1;
    cached.source_h = 1;
    replacement.layers.push_back(cached);
    store.Commit(std::move(replacement));
    pipe.OnTick();
    pipe.OnCaptureReady(2);
    pipe.OnPaint(pixels.data(), 65, 65, 3);
    StampCaptureMarker(pixels, 65, 2);
    pipe.OnPaint(pixels.data(), 65, 65, 4);

    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "cache-only replacement capture failed");
    CHECK(!pipe.NeedsLivePaint(), "cache-only graph still requests live paint");
    CHECK(pipe.OnPaint(pixels.data(), 65, 65, 5)
              == bg::compositor::PaintDisposition::ConsumedByCapture,
          "cache-only paint disposition");
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "stale live identity forced cache-only graph into fallback");
}

TEST(LivePipelineAppliesCefDirtyRectsToWarmLiveBitmap) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snapshot;
    snapshot.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "clock";
    layer.kind = bg::ProtocolNodeKind::LiveHtml;
    layer.source_w = 2;
    layer.source_h = 1;
    snapshot.layers.push_back(layer);
    store.Commit(std::move(snapshot));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 66, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    pipe.OnCaptureReady(1);
    std::vector<uint8_t> initial(66 * 65 * 4, 0x44);
    pipe.OnPaint(initial.data(), 66, 65, 1);
    StampCaptureMarker(initial, 66, 1);
    pipe.OnPaint(initial.data(), 66, 65, 2);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "initial live capture failed");

    std::vector<uint8_t> next(66 * 65 * 4, 0x88);
    const std::vector<bg::compositor::LayerDirtyRect> dirty = {
        {32, 32, 1, 1},
    };
    CHECK(pipe.OnPaint(next.data(), 66, 65, 3, dirty)
              == bg::compositor::PaintDisposition::ConsumedByCompose,
          "dirty live paint was not consumed for compose");
    std::vector<uint8_t> output(66 * 65 * 4);
    CHECK(pipe.ComposeInto(output.data(), 66, 65),
          "compose after dirty live update failed");
    CHECK(output[0] == 0x88 && output[3] == 0x88,
          "dirty source pixel was not updated");
    CHECK(output[4] == 0x44 && output[7] == 0x44,
          "clean source pixel was overwritten");
    CHECK(pipe.stats().live_region_updates == 1,
          "dirty update telemetry count mismatch");
    CHECK(pipe.stats().live_region_bytes == 4,
          "dirty update telemetry byte count mismatch");
    CHECK(pipe.stats().live_full_bytes == 66u * 65u * 4u,
          "dirty update full-copy baseline mismatch");
}

TEST(LivePipelineMissingCacheFailsClosed) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot first;
    first.graph_revision = 1;
    bg::ProtocolLayerNode layer_a;
    layer_a.id = "a";
    layer_a.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer_a.source_w = 1;
    layer_a.source_h = 1;
    first.layers.push_back(layer_a);
    store.Commit(std::move(first));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    pipe.OnCaptureReady(1);
    std::vector<uint8_t> pixels(65 * 65 * 4, 0x44);
    pipe.OnPaint(pixels.data(), 65, 65, 1);
    StampCaptureMarker(pixels, 65, 1);
    pipe.OnPaint(pixels.data(), 65, 65, 2);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "capture did not complete");

    bg::ProtocolSnapshot changed_state;
    changed_state.graph_revision = 1;
    changed_state.state_revision = 1;
    changed_state.layers.push_back(layer_a);
    bg::ProtocolLayerNode layer_b = layer_a;
    layer_b.id = "b";
    changed_state.layers.push_back(layer_b);
    store.Commit(std::move(changed_state));

    std::vector<uint8_t> dst(65 * 65 * 4);
    CHECK(!pipe.ComposeInto(dst.data(), 65, 65),
          "compose unexpectedly accepted missing cache");
    CHECK(pipe.mode() == bg::compositor::PipelineMode::FallbackMonolith,
          "missing cache must enter whole-template fallback");
}

TEST(LivePipelineRecapturesOnlyExplicitlyInvalidatedContent) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot initial;
    initial.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 1;
    layer.source_h = 1;
    layer.id = "a";
    initial.layers.push_back(layer);
    layer.id = "b";
    initial.layers.push_back(layer);
    store.Commit(std::move(initial));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    std::vector<uint8_t> pixels(65 * 65 * 4, 0x66);
    const auto complete_capture = [&](uint64_t seq) {
        pipe.OnCaptureReady(seq);
        pipe.OnPaint(pixels.data(), 65, 65, seq * 2);
        StampCaptureMarker(pixels, 65, seq);
        pipe.OnPaint(pixels.data(), 65, 65, seq * 2 + 1);
    };
    complete_capture(1);
    complete_capture(2);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "initial two-layer capture failed");

    bg::ProtocolSnapshot props_only = *store.Current();
    props_only.state_revision = 1;
    props_only.layers[0].opacity = 0.5f;
    store.Commit(std::move(props_only));
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "props-only state incorrectly triggered recapture");
    CHECK(pipe.stats().capture_passes == 1,
          "props-only state incremented capture pass");

    bg::ProtocolSnapshot content_update = *store.Current();
    content_update.state_revision = 2;
    content_update.invalidated_layer_ids = {"a"};
    store.Commit(std::move(content_update));
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Capturing,
          "content invalidation did not start selective capture");
    complete_capture(3);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "selective capture did not complete after one layer");
    CHECK(pipe.stats().capture_passes == 2,
          "selective capture pass count is wrong");
    std::vector<uint8_t> output(65 * 65 * 4);
    CHECK(pipe.ComposeInto(output.data(), 65, 65),
          "non-invalidated sibling was lost during selective recapture");
}

TEST(LivePipelineDoesNotRestartCaptureForPropsOnlyFrames) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot initial;
    initial.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 1;
    layer.source_h = 1;
    layer.id = "a";
    initial.layers.push_back(layer);
    layer.id = "b";
    initial.layers.push_back(layer);
    store.Commit(std::move(initial));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    bg::ProtocolSnapshot props = *store.Current();
    props.state_revision = 1;
    props.layers[0].opacity = 0.5f;
    store.Commit(std::move(props));
    pipe.OnTick();
    CHECK(pipe.stats().capture_passes == 1,
          "props-only frame restarted the in-flight capture");

    std::vector<uint8_t> pixels(65 * 65 * 4, 0x66);
    const auto complete_capture = [&](uint64_t seq) {
        pipe.OnCaptureReady(seq);
        pipe.OnPaint(pixels.data(), 65, 65, seq * 2);
        StampCaptureMarker(pixels, 65, seq);
        pipe.OnPaint(pixels.data(), 65, 65, seq * 2 + 1);
    };
    complete_capture(1);
    complete_capture(2);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "capture did not finish across props-only revisions");
}

TEST(LivePipelineKeepsPublishingWhileSelectiveCaptureRuns) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot initial;
    initial.graph_revision = 1;
    bg::ProtocolLayerNode cached;
    cached.id = "text";
    cached.kind = bg::ProtocolNodeKind::CachedBitmap;
    cached.source_w = 1;
    cached.source_h = 1;
    initial.layers.push_back(cached);
    bg::ProtocolLayerNode live = cached;
    live.id = "clock";
    live.kind = bg::ProtocolNodeKind::LiveHtml;
    live.opacity = 0.0f;
    initial.layers.push_back(live);
    store.Commit(std::move(initial));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();
    std::vector<uint8_t> pixels(65 * 65 * 4, 0x66);
    const auto complete_capture = [&](uint64_t seq) {
        pipe.OnCaptureReady(seq);
        pipe.OnPaint(pixels.data(), 65, 65, seq * 2);
        StampCaptureMarker(pixels, 65, seq);
        pipe.OnPaint(pixels.data(), 65, 65, seq * 2 + 1);
    };
    complete_capture(1);
    complete_capture(2);
    std::vector<uint8_t> output(65 * 65 * 4);
    CHECK(pipe.ComposeIncrementalInto(output.data(), 65, 65),
          "initial cached+live compose failed");

    bg::ProtocolSnapshot update = *store.Current();
    update.state_revision = 1;
    update.invalidated_layer_ids = {"text"};
    store.Commit(std::move(update));
    pipe.OnTick();
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Capturing,
          "content invalidation did not start selective capture");
    CHECK(pipe.PrefersComposedOutput() && pipe.HasReusableLiveFrame(),
          "selective capture stopped reusable output publication");
    CHECK(pipe.ComposeIncrementalInto(output.data(), 65, 65),
          "stale-safe compose failed during selective capture");
    std::fill(pixels.begin(), pixels.end(), 0x77);
    complete_capture(3);
    CHECK(pipe.ComposeIncrementalInto(output.data(), 65, 65),
          "compose after selective cache replacement failed");
    CHECK(output[0] == 0x77,
          "cache replacement was lost after stale intermediate compose");
    complete_capture(4);
}

TEST(LivePipelineDirtyTilesMatchFullComposeAfterMove) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot initial;
    initial.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 1;
    layer.source_h = 1;
    initial.layers.push_back(layer);
    store.Commit(std::move(initial));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 256, 256);
    pipe.set_enabled(true);
    pipe.OnTick();
    std::vector<uint8_t> pixels(256 * 256 * 4, 0x66);
    pipe.OnCaptureReady(1);
    pipe.OnPaint(pixels.data(), 256, 256, 1);
    StampCaptureMarker(pixels, 256, 1);
    pipe.OnPaint(pixels.data(), 256, 256, 2);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "initial capture failed");

    std::vector<uint8_t> incremental(256 * 256 * 4);
    CHECK(pipe.ComposeIncrementalInto(incremental.data(), 256, 256),
          "initial incremental compose failed");
    bg::ProtocolSnapshot moved = *store.Current();
    moved.state_revision = 1;
    moved.layers[0].layout_position.x = 128;
    store.Commit(std::move(moved));
    pipe.OnTick();
    CHECK(pipe.ComposeIncrementalInto(incremental.data(), 256, 256),
          "dirty-tile compose failed");

    std::vector<uint8_t> expected(256 * 256 * 4);
    CHECK(pipe.ComposeInto(expected.data(), 256, 256),
          "full reference compose failed");
    CHECK(std::memcmp(
              incremental.data(), expected.data(), expected.size()) == 0,
          "dirty-tile compose diverges from full reference");
    CHECK(pipe.stats().incremental_frames == 1,
          "moved layer did not use incremental compose");
    CHECK(pipe.stats().incremental_tiles > 0,
          "incremental compose reported no dirty regions");
}

TEST(LivePipelineDirtyTilesTrackAffineOpacityAndMaskChanges) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot initial;
    initial.graph_revision = 1;
    bg::ProtocolLayerNode source;
    source.id = "source";
    source.kind = bg::ProtocolNodeKind::CachedBitmap;
    source.source_w = 64;
    source.source_h = 64;
    source.has_affine = true;
    source.affine[0] = 1.0f;
    source.affine[1] = 0.0f;
    source.affine[2] = 128.0f;
    source.affine[3] = 0.0f;
    source.affine[4] = 1.0f;
    source.affine[5] = 128.0f;
    initial.layers.push_back(source);
    bg::ProtocolLayerNode mask;
    mask.id = "mask";
    mask.kind = bg::ProtocolNodeKind::MaskOperator;
    mask.mask_mode = bg::ProtocolMaskMode::Normal;
    mask.mask_rect = {112, 112, 96, 96};
    mask.affected_source_ids = {"source"};
    initial.layers.push_back(mask);
    store.Commit(std::move(initial));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 512, 512);
    pipe.set_enabled(true);
    pipe.OnTick();
    std::vector<uint8_t> pixels(512 * 512 * 4, 0x66);
    pipe.OnCaptureReady(1);
    pipe.OnPaint(pixels.data(), 512, 512, 1);
    StampCaptureMarker(pixels, 512, 1);
    pipe.OnPaint(pixels.data(), 512, 512, 2);

    std::vector<uint8_t> incremental(512 * 512 * 4);
    CHECK(pipe.ComposeIncrementalInto(incremental.data(), 512, 512),
          "initial masked incremental compose failed");
    for (uint64_t step = 1; step <= 20; ++step) {
        bg::ProtocolSnapshot next = *store.Current();
        next.state_revision = step;
        next.layers[0].affine[2] = 128.0f + static_cast<float>(step * 3);
        next.layers[0].affine[5] = 128.0f + static_cast<float>(step % 5);
        next.layers[0].opacity =
            step % 3 == 0 ? 0.5f : 1.0f;
        next.layers[1].mask_rect.x = 112 + static_cast<int32_t>(step * 2);
        next.layers[1].mask_rect.y = 112 + static_cast<int32_t>(step % 7);
        store.Commit(std::move(next));
        pipe.OnTick();
        CHECK(pipe.ComposeIncrementalInto(
                  incremental.data(), 512, 512),
              "incremental animated operator compose failed");
        std::vector<uint8_t> expected(512 * 512 * 4);
        CHECK(pipe.ComposeInto(expected.data(), 512, 512),
              "full animated operator reference failed");
        CHECK(std::memcmp(
                  incremental.data(), expected.data(), expected.size()) == 0,
              "dirty tiles diverge under affine/opacity/mask animation");
    }
    CHECK(pipe.stats().incremental_frames == 20,
          "animated operators unexpectedly forced full compose");
}

TEST(LivePipelineRestartsCaptureWhenGraphChangesMidPass) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot first;
    first.graph_revision = 1;
    bg::ProtocolLayerNode layer;
    layer.id = "a";
    layer.kind = bg::ProtocolNodeKind::CachedBitmap;
    layer.source_w = 1;
    layer.source_h = 1;
    first.layers.push_back(layer);
    store.Commit(std::move(first));

    bg::compositor::LivePipeline pipe;
    pipe.Attach(&store, 65, 65);
    pipe.set_enabled(true);
    pipe.OnTick();

    bg::ProtocolSnapshot second;
    second.graph_revision = 2;
    layer.id = "b";
    second.layers.push_back(layer);
    store.Commit(std::move(second));
    pipe.OnTick();

    pipe.OnCaptureReady(1);
    std::vector<uint8_t> pixels(65 * 65 * 4, 0x55);
    pipe.OnPaint(pixels.data(), 65, 65, 1);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Capturing,
          "stale acknowledgement completed replacement capture");

    pipe.OnCaptureReady(2);
    StampCaptureMarker(pixels, 65, 2);
    pipe.OnPaint(pixels.data(), 65, 65, 2);
    pipe.OnPaint(pixels.data(), 65, 65, 3);
    CHECK(pipe.mode() == bg::compositor::PipelineMode::Composing,
          "replacement graph capture did not complete");
}

int main() {
    const auto& tests = Registry();
    int run = 0;
    int passed = 0;
    for (const auto& t : tests) {
        std::printf("[ RUN      ] %s\n", t.name);
        const int before = g_failures;
        t.fn();
        ++run;
        if (g_failures == before) {
            ++passed;
            std::printf("[       OK ] %s\n", t.name);
        } else {
            std::printf("[   FAILED ] %s\n", t.name);
        }
    }
    std::printf("\n%d/%d tests passed, %d failed\n", passed, run, g_failures);
    return g_failures == 0 ? 0 : 1;
}
