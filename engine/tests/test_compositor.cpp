// engine/tests/test_compositor.cpp
//
// CTest for the Doc02 synthetic snapshot builder + layered compositor. The
// mixer goldens live in test_mixer.cpp; here we verify the orchestrator wires
// the protocol snapshot into MixInput correctly.

#include "../src/compositor/layered_compositor.h"
#include "../src/compositor/synthetic_snapshot.h"
#include "../src/mixer/protocol_types.h"

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

TEST(EmptySnapshotProducesZeroLayers) {
    bg::ProtocolSnapshot snap;
    auto s = bg::compositor::BuildSyntheticSnapshot(snap);
    CHECK(s.input.layers.empty(), "empty snapshot produced layers");
    CHECK(s.input.canvas_width >= 1, "canvas width degenerate");
    CHECK(s.input.canvas_height >= 1, "canvas height degenerate");
}

TEST(SyntheticSnapshotBakesPixelBearingLayers) {
    bg::ProtocolSnapshot snap;
    snap.layers.push_back({});
    snap.layers.back().id = "a";
    snap.layers.back().kind = bg::ProtocolNodeKind::CachedBitmap;
    snap.layers.back().source_w = 4;
    snap.layers.back().source_h = 4;
    snap.layers.back().layout_position.x = 0;
    snap.layers.back().layout_position.y = 0;
    auto s = bg::compositor::BuildSyntheticSnapshot(snap);
    CHECK(s.input.layers.size() == 1, "expected one pixel layer");
    CHECK(s.input.layers[0].buffer.width == 4, "buffer width mismatch");
    CHECK(s.input.layers[0].buffer.height == 4, "buffer height mismatch");
    CHECK(!s.input.layers[0].mask.has_value(), "no mask expected");
}

TEST(SyntheticSnapshotSkipsMaskOperatorAndAppliesToNextLayer) {
    bg::ProtocolSnapshot snap;
    snap.layers.push_back({});
    snap.layers.back().id = "m";
    snap.layers.back().kind = bg::ProtocolNodeKind::MaskOperator;
    snap.layers.back().mask_mode = bg::ProtocolMaskMode::Inverted;
    snap.layers.back().mask_rect = {0, 0, 2, 2};
    snap.layers.push_back({});
    snap.layers.back().id = "a";
    snap.layers.back().kind = bg::ProtocolNodeKind::CachedBitmap;
    snap.layers.back().source_w = 4;
    snap.layers.back().source_h = 4;
    auto s = bg::compositor::BuildSyntheticSnapshot(snap);
    CHECK(s.input.layers.size() == 1, "mask operator should not emit a layer");
    CHECK(s.input.layers[0].mask.has_value(), "mask op should attach to next layer");
    CHECK(s.input.layers[0].mask->mode == bg::MaskMode::Inverted,
          "mask mode mismatch");
    CHECK(s.input.layers[0].mask->rect.width == 2, "mask rect width mismatch");
}

TEST(LayeredCompositorFallsBackOnUnsupportedLayout) {
    bg::ProtocolSnapshot snap;
    snap.layers.push_back({});
    snap.layers.back().id = "a";
    snap.layers.back().kind = bg::ProtocolNodeKind::CachedBitmap;
    snap.layers.back().source_w = 2;
    snap.layers.back().source_h = 2;
    snap.layers.back().rotation_deg = 17.5f;
    auto s = bg::compositor::BuildSyntheticSnapshot(snap);
    bg::compositor::LayeredCompositor c;
    std::vector<uint8_t> dst(8 * 4, 0);
    auto res = c.Composite(s, 8, 1, dst.data());
    CHECK(!res.ok, "fractional rotation should fall back");
    CHECK(!res.fallback_reasons.empty(), "fallback reasons should be populated");
}

TEST(LayeredCompositorProducesNonZeroOutputForOpaqueSource) {
    bg::ProtocolSnapshot snap;
    snap.layers.push_back({});
    snap.layers.back().id = "a";
    snap.layers.back().kind = bg::ProtocolNodeKind::CachedBitmap;
    snap.layers.back().source_w = 2;
    snap.layers.back().source_h = 1;
    snap.layers.back().opacity = 1.0f;
    auto s = bg::compositor::BuildSyntheticSnapshot(snap);
    bg::compositor::LayeredCompositor c;
    std::vector<uint8_t> dst(2 * 4, 0);
    auto res = c.Composite(s, 2, 1, dst.data());
    CHECK(res.ok, "supported composition failed");
    bool any_nonzero = false;
    for (size_t i = 0; i < dst.size(); ++i) {
        if (dst[i] != 0) {
            any_nonzero = true;
            break;
        }
    }
    CHECK(any_nonzero, "composition wrote only zeros");
}

TEST(LayeredCompositorMeasuresTime) {
    bg::ProtocolSnapshot snap;
    snap.layers.push_back({});
    snap.layers.back().id = "a";
    snap.layers.back().kind = bg::ProtocolNodeKind::CachedBitmap;
    snap.layers.back().source_w = 64;
    snap.layers.back().source_h = 64;
    auto s = bg::compositor::BuildSyntheticSnapshot(snap);
    bg::compositor::LayeredCompositor c;
    std::vector<uint8_t> dst(64 * 64 * 4, 0);
    auto res = c.Composite(s, 64, 64, dst.data());
    CHECK(res.ok, "supported composition failed");
    CHECK(res.compose_ns > 0, "compose_ns should be positive");
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
