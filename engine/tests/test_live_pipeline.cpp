// engine/tests/test_live_pipeline.cpp
//
// Unit tests for LayerBitmapCache and LivePipeline graph-support helpers
// that do not require CEF.

#include "../src/compositor/layer_bitmap_cache.h"
#include "../src/compositor/live_pipeline.h"
#include "../src/mixer/protocol_types.h"
#include "../src/mixer/render_graph_store.h"

#include <cstdio>
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
    snap.revision = 1;
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

TEST(LivePipelineUnsupportedGraphFallsBack) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot snap;
    snap.revision = 2;
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
    CHECK(pipe.mode() == bg::compositor::PipelineMode::FallbackMonolith,
          "fractional rotation must fall back");
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
