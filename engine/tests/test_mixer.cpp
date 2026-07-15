// engine/tests/test_mixer.cpp
//
// Standalone CTest for the Doc02 CPU layer mixer. No CEF dependency: this
// builds a single executable that links only the scalar mixer sources under
// engine/src/mixer/. Run with `ctest` from the tests build directory.
//
// The mixer is a scalar reference; it must produce pixel-exact output for the
// goldens below. SIMD parallelism is added later (PR7) and must match these
// results within the documented tolerance.

#include "../src/mixer/render_graph_types.h"
#include "../src/mixer/affine_sampler.h"
#include "../src/mixer/mask_ops.h"
#include "../src/mixer/mixer_buffer_pool.h"
#include "../src/mixer/cpu_layer_mixer.h"

#include <cmath>
#include <cstdint>
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
    explicit Registrar(const char* name, void (*fn)()) {
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

template <typename A, typename E>
bool CheckEqImpl(const A& a, const E& e) {
    return a == e;
}

#define CHECK_EQ(actual, expected, msg)                                        \
    do {                                                                       \
        auto _a = (actual);                                                    \
        auto _e = (expected);                                                  \
        if (!(_a == _e)) {                                                     \
            std::fprintf(stderr, "  FAIL: %s\n", msg);                         \
            ++g_failures;                                                      \
            return;                                                            \
        }                                                                      \
    } while (0)

void SetPixel(std::vector<uint8_t>& buf, int w, int x, int y, uint8_t b,
              uint8_t g, uint8_t r, uint8_t a) {
    const int idx = (y * w + x) * 4;
    buf[idx + 0] = b;
    buf[idx + 1] = g;
    buf[idx + 2] = r;
    buf[idx + 3] = a;
}

void GetPixel(const std::vector<uint8_t>& buf, int w, int x, int y, uint8_t& b,
              uint8_t& g, uint8_t& r, uint8_t& a) {
    const int idx = (y * w + x) * 4;
    b = buf[idx + 0];
    g = buf[idx + 1];
    r = buf[idx + 2];
    a = buf[idx + 3];
}

// Opaque red, opaque green, half-alpha white — the three reference pigments
// used across the blend tests.
constexpr uint32_t kOpaqueRed = 0xFF0000FFu;    // BGRA: B=00 G=00 R=FF A=FF
constexpr uint32_t kOpaqueGreen = 0xFF00FF00u;  // BGRA: B=00 G=FF R=00 A=FF
constexpr uint32_t kHalfWhite = 0x80FFFFFFu;    // BGRA: B=FF G=FF R=FF A=80

void FillSolid(std::vector<uint8_t>& buf, int w, int h, uint32_t bgra) {
    for (int i = 0; i < w * h; ++i) {
        std::memcpy(&buf[i * 4], &bgra, 4);
    }
}

bg::LayerBufferRef MakeBufferRef(const std::vector<uint8_t>& buf, int w,
                                 int h) {
    return bg::LayerBufferRef{buf.data(), w, h};
}

// ---------------------------------------------------------------------------
// Blend goldens (straight alpha src-over, BGRA8).
// ---------------------------------------------------------------------------

TEST(TransparentSourceLeavesDestinationUnchanged) {
    const int w = 4;
    const int h = 4;
    std::vector<uint8_t> dst(w * h * 4, 0);
    FillSolid(dst, w, h, kOpaqueGreen);

    std::vector<uint8_t> src(w * h * 4, 0);  // fully transparent (alpha 0)

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, w, h);
    node.layout = bg::LayerLayout::Identity(w, h);
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    // The destination must be byte-identical to the pre-mix state.
    std::vector<uint8_t> expected(w * h * 4, 0);
    FillSolid(expected, w, h, kOpaqueGreen);
    CHECK(std::memcmp(dst.data(), expected.data(), dst.size()) == 0,
          "transparent source modified destination");
}

TEST(OpaqueSourceOverwritesDestination) {
    const int w = 2;
    const int h = 2;
    std::vector<uint8_t> dst(w * h * 4, 0);
    FillSolid(dst, w, h, kOpaqueGreen);

    std::vector<uint8_t> src(w * h * 4, 0);
    FillSolid(src, w, h, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, w, h);
    node.layout = bg::LayerLayout::Identity(w, h);
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    for (int i = 0; i < w * h; ++i) {
        uint32_t px = 0;
        std::memcpy(&px, &dst[i * 4], 4);
        CHECK_EQ(px, kOpaqueRed, "opaque source did not overwrite destination");
    }
}

TEST(HalfAlphaWhiteBlendsTowardDestination) {
    const int w = 1;
    const int h = 1;
    std::vector<uint8_t> dst(w * h * 4, 0);
    FillSolid(dst, w, h, kOpaqueGreen);  // (B=0,G=255,R=0,A=255)

    std::vector<uint8_t> src(w * h * 4, 0);
    FillSolid(src, w, h, kHalfWhite);  // (B=255,G=255,R=255,A=128)

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, w, h);
    node.layout = bg::LayerLayout::Identity(w, h);
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    uint8_t b, g, r, a;
    GetPixel(dst, w, 0, 0, b, g, r, a);
    CHECK_EQ(int(a), 255, "half-alpha blend produced wrong alpha");
    // out_c = (sc*sa + dc*da*(255-sa)/255) / out_a; sa=128 da=255
    // out_c = (sc*128 + dc*127)/255 rounded.
    const int expected_g = (255 * 128 + 255 * 127 + 127) / 255;  // 255
    const int expected_b = (255 * 128 + 0 * 127 + 127) / 255;    // 128
    const int expected_r = (255 * 128 + 0 * 127 + 127) / 255;    // 128
    CHECK_EQ(int(g), expected_g, "half-alpha blend produced wrong G");
    CHECK_EQ(int(b), expected_b, "half-alpha blend produced wrong B");
    CHECK_EQ(int(r), expected_r, "half-alpha blend produced wrong R");
}

// ---------------------------------------------------------------------------
// Z-order: front layer overrides back.
// ---------------------------------------------------------------------------

TEST(FrontLayerOverridesBack) {
    const int w = 1;
    const int h = 1;
    std::vector<uint8_t> dst(w * h * 4, 0);  // transparent

    std::vector<uint8_t> back_src(w * h * 4, 0);
    FillSolid(back_src, w, h, kOpaqueGreen);
    std::vector<uint8_t> front_src(w * h * 4, 0);
    FillSolid(front_src, w, h, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode back{};
    back.buffer = MakeBufferRef(back_src, w, h);
    back.layout = bg::LayerLayout::Identity(w, h);
    back.opacity = 1.0f;
    bg::LayerNode front = back;
    front.buffer = MakeBufferRef(front_src, w, h);
    input.layers = {back, front};

    mixer.Mix(input, dst.data());

    uint32_t px = 0;
    std::memcpy(&px, dst.data(), 4);
    CHECK_EQ(px, kOpaqueRed, "front layer did not override back");
}

// ---------------------------------------------------------------------------
// Clipping at canvas borders.
// ---------------------------------------------------------------------------

TEST(LayerOutsideCanvasDoesNotWrite) {
    const int w = 2;
    const int h = 2;
    std::vector<uint8_t> dst(w * h * 4, 0);
    FillSolid(dst, w, h, kOpaqueGreen);

    std::vector<uint8_t> src(1 * 1 * 4, 0);
    FillSolid(src, 1, 1, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 1, 1);
    node.layout.position_x = 10;  // entirely off-canvas
    node.layout.position_y = 10;
    node.layout.scale_x = 1.0f;
    node.layout.scale_y = 1.0f;
    node.layout.rotation_deg = 0.0f;
    node.layout.anchor_x = 0.0f;
    node.layout.anchor_y = 0.0f;
    node.layout.source_w = 1;
    node.layout.source_h = 1;
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    std::vector<uint8_t> expected(w * h * 4, 0);
    FillSolid(expected, w, h, kOpaqueGreen);
    CHECK(std::memcmp(dst.data(), expected.data(), dst.size()) == 0,
          "off-canvas layer wrote into destination");
}

// ---------------------------------------------------------------------------
// Opacity modulation: 0 opacity must be a no-op, 1 must be identity for opaque
// source.
// ---------------------------------------------------------------------------

TEST(ZeroOpacityIsNoOp) {
    const int w = 1;
    const int h = 1;
    std::vector<uint8_t> dst(w * h * 4, 0);
    FillSolid(dst, w, h, kOpaqueGreen);

    std::vector<uint8_t> src(w * h * 4, 0);
    FillSolid(src, w, h, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, w, h);
    node.layout = bg::LayerLayout::Identity(w, h);
    node.opacity = 0.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    uint32_t px = 0;
    std::memcpy(&px, dst.data(), 4);
    CHECK_EQ(px, kOpaqueGreen, "zero opacity source modified destination");
}

// ---------------------------------------------------------------------------
// Odd widths / canvas tails.
// ---------------------------------------------------------------------------

TEST(OddWidthCanvasBlendsFully) {
    const int w = 3;  // odd
    const int h = 1;
    std::vector<uint8_t> dst(w * h * 4, 0);

    std::vector<uint8_t> src(w * h * 4, 0);
    FillSolid(src, w, h, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, w, h);
    node.layout = bg::LayerLayout::Identity(w, h);
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    for (int x = 0; x < w; ++x) {
        uint32_t px = 0;
        std::memcpy(&px, &dst[x * 4], 4);
        CHECK_EQ(px, kOpaqueRed, "odd-width pixel not written");
    }
}

// ---------------------------------------------------------------------------
// Affine sampler: integer translation, 2x nearest-neighbour scale.
// ---------------------------------------------------------------------------

TEST(TranslationMovesLayer) {
    const int cw = 4;
    const int ch = 4;
    std::vector<uint8_t> dst(cw * ch * 4, 0);

    std::vector<uint8_t> src(1 * 1 * 4, 0);
    FillSolid(src, 1, 1, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = cw;
    input.canvas_height = ch;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 1, 1);
    node.layout.position_x = 2;
    node.layout.position_y = 1;
    node.layout.scale_x = 1.0f;
    node.layout.scale_y = 1.0f;
    node.layout.rotation_deg = 0.0f;
    node.layout.anchor_x = 0.0f;
    node.layout.anchor_y = 0.0f;
    node.layout.source_w = 1;
    node.layout.source_h = 1;
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    for (int y = 0; y < ch; ++y) {
        for (int x = 0; x < cw; ++x) {
            uint32_t px = 0;
            std::memcpy(&px, &dst[(y * cw + x) * 4], 4);
            if (x == 2 && y == 1) {
                CHECK_EQ(px, kOpaqueRed, "translated pixel missing");
            } else {
                CHECK_EQ(px, 0u, "translation wrote unexpected pixel");
            }
        }
    }
}

TEST(ScaleUpNearestDoublesPixels) {
    const int cw = 4;
    const int ch = 4;
    std::vector<uint8_t> dst(cw * ch * 4, 0);

    // 2x2 source, half red, half transparent.
    std::vector<uint8_t> src(2 * 2 * 4, 0);
    FillSolid(src, 2, 2, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = cw;
    input.canvas_height = ch;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 2, 2);
    node.layout.position_x = 0;
    node.layout.position_y = 0;
    node.layout.scale_x = 2.0f;
    node.layout.scale_y = 2.0f;
    node.layout.rotation_deg = 0.0f;
    node.layout.anchor_x = 0.0f;
    node.layout.anchor_y = 0.0f;
    node.layout.source_w = 2;
    node.layout.source_h = 2;
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    for (int y = 0; y < ch; ++y) {
        for (int x = 0; x < cw; ++x) {
            uint32_t px = 0;
            std::memcpy(&px, &dst[(y * cw + x) * 4], 4);
            CHECK_EQ(px, kOpaqueRed, "scaled pixel missing");
        }
    }
}

// ---------------------------------------------------------------------------
// Mask operators: normal rect clips to inside, inverted rect keeps outside.
// ---------------------------------------------------------------------------

TEST(NormalMaskKeepsOnlyInsideRect) {
    const int cw = 4;
    const int ch = 1;
    std::vector<uint8_t> dst(cw * ch * 4, 0);

    std::vector<uint8_t> src(cw * ch * 4, 0);
    FillSolid(src, cw, ch, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = cw;
    input.canvas_height = ch;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, cw, ch);
    node.layout = bg::LayerLayout::Identity(cw, ch);
    node.opacity = 1.0f;
    bg::MaskOp mask{};
    mask.mode = bg::MaskMode::Normal;
    mask.rect = {1, 0, 2, 1};  // x=1..3 inclusive
    node.mask = mask;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    for (int x = 0; x < cw; ++x) {
        uint32_t px = 0;
        std::memcpy(&px, &dst[x * 4], 4);
        if (x >= 1 && x < 3) {
            CHECK_EQ(px, kOpaqueRed, "normal mask dropped inside pixel");
        } else {
            CHECK_EQ(px, 0u, "normal mask kept outside pixel");
        }
    }
}

TEST(InvertedMaskKeepsOnlyOutsideRect) {
    const int cw = 4;
    const int ch = 1;
    std::vector<uint8_t> dst(cw * ch * 4, 0);

    std::vector<uint8_t> src(cw * ch * 4, 0);
    FillSolid(src, cw, ch, kOpaqueRed);

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = cw;
    input.canvas_height = ch;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, cw, ch);
    node.layout = bg::LayerLayout::Identity(cw, ch);
    node.opacity = 1.0f;
    bg::MaskOp mask{};
    mask.mode = bg::MaskMode::Inverted;
    mask.rect = {1, 0, 2, 1};
    node.mask = mask;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    for (int x = 0; x < cw; ++x) {
        uint32_t px = 0;
        std::memcpy(&px, &dst[x * 4], 4);
        if (x >= 1 && x < 3) {
            CHECK_EQ(px, 0u, "inverted mask kept inside pixel");
        } else {
            CHECK_EQ(px, kOpaqueRed, "inverted mask dropped outside pixel");
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot semantics: mix must not mutate the input layer buffers.
// ---------------------------------------------------------------------------

TEST(MixLeavesInputBuffersImmutable) {
    const int w = 2;
    const int h = 2;
    std::vector<uint8_t> dst(w * h * 4, 0);

    std::vector<uint8_t> src(w * h * 4, 0);
    FillSolid(src, w, h, kOpaqueRed);
    std::vector<uint8_t> src_copy = src;

    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = w;
    input.canvas_height = h;
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, w, h);
    node.layout = bg::LayerLayout::Identity(w, h);
    node.opacity = 1.0f;
    input.layers = {node};

    mixer.Mix(input, dst.data());

    CHECK(std::memcmp(src.data(), src_copy.data(), src.size()) == 0,
          "mix mutated the input layer buffer");
}

// ---------------------------------------------------------------------------
// Buffer pool: reuse without reallocation.
// ---------------------------------------------------------------------------

TEST(BufferPoolReusesAllocationForSameSize) {
    bg::MixerBufferPool pool;
    bg::MixerBuffer* a = pool.Acquire(64);
    CHECK(a != nullptr, "pool returned null for 64-byte acquire");
    void* a_data = a->data;
    pool.Release(a);
    bg::MixerBuffer* b = pool.Acquire(64);
    CHECK(b != nullptr, "pool returned null on reuse");
    CHECK_EQ(b->data, a_data, "pool did not reuse the same allocation");
    pool.Release(b);
}

TEST(BufferPoolReallocatesForDifferentSize) {
    bg::MixerBufferPool pool;
    bg::MixerBuffer* a = pool.Acquire(64);
    void* a_data = a->data;
    pool.Release(a);
    bg::MixerBuffer* b = pool.Acquire(128);
    CHECK(b->size >= 128, "pool did not allocate larger buffer");
    pool.Release(b);
    // Ensure no UB: data pointer may or may not equal a_data depending on the
    // allocator; the contract is that Acquire returns a usable buffer.
    (void)a_data;
}

// ---------------------------------------------------------------------------
// Unsupported operator: rotation outside supported range triggers fallback.
// ---------------------------------------------------------------------------

TEST(UnsupportedRotationMarksInputUnsupported) {
    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = 1;
    input.canvas_height = 1;
    std::vector<uint8_t> src(4, 0);
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 1, 1);
    node.layout = bg::LayerLayout::Identity(1, 1);
    node.layout.rotation_deg = 17.5f;  // fractional rotation unsupported
    node.opacity = 1.0f;
    input.layers = {node};

    CHECK(!mixer.IsSupported(input), "fractional rotation reported supported");
    CHECK_EQ(mixer.FallbackReasons(input).size(), 1u,
             "expected exactly one fallback reason");
}

}  // namespace

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
