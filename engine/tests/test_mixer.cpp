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
#include "../src/mixer/simd_blend.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
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
constexpr uint32_t kOpaqueRed = 0xFFFF0000u;    // BGRA: B=00 G=00 R=FF A=FF
constexpr uint32_t kOpaqueGreen = 0xFF00FF00u;  // BGRA: B=00 G=FF R=00 A=FF
constexpr uint32_t kOpaqueBlue = 0xFF0000FFu;   // BGRA: B=FF G=00 R=00 A=FF
constexpr uint32_t kHalfWhite = 0x80808080u;    // premul BGRA: 50% white

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
// Blend goldens (CEF-compatible premultiplied-alpha src-over, BGRA8).
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
    FillSolid(src, w, h, kHalfWhite);  // (B=128,G=128,R=128,A=128)

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
    // Premultiplied src-over: out = src + dst*(1-sa).
    const int expected_g = 128 + (255 * 127 + 127) / 255;  // 255
    const int expected_b = 128;
    const int expected_r = 128;
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
    mask.rect = {1, 0, 2, 1};  // half-open x=[1,3)
    node.masks.push_back(mask);
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
    node.masks.push_back(mask);
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
// Arbitrary finite 2D rotation is part of the PR2 contract.
// ---------------------------------------------------------------------------

TEST(FractionalRotationIsSupported) {
    bg::CpuLayerMixer mixer;
    bg::MixInput input{};
    input.canvas_width = 8;
    input.canvas_height = 8;
    std::vector<uint8_t> src(2 * 2 * 4, 0);
    FillSolid(src, 2, 2, kOpaqueRed);
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 2, 2);
    node.layout = bg::LayerLayout::Identity(2, 2);
    node.layout.position_x = 3;
    node.layout.position_y = 3;
    node.layout.rotation_deg = 17.5f;
    node.opacity = 1.0f;
    input.layers = {node};

    CHECK(mixer.IsSupported(input), "finite fractional rotation rejected");
    std::vector<uint8_t> dst(8 * 8 * 4, 0);
    mixer.Mix(input, dst.data());
    bool any_nonzero = false;
    for (const auto byte : dst) any_nonzero = any_nonzero || byte != 0;
    CHECK(any_nonzero, "fractional rotation produced no pixels");
}

TEST(Rotation90UsesTransformedBoundingBox) {
    const int cw = 4;
    const int ch = 4;
    std::vector<uint8_t> src(2 * 1 * 4, 0);
    SetPixel(src, 2, 0, 0, 0, 0, 255, 255);
    SetPixel(src, 2, 1, 0, 0, 255, 0, 255);
    std::vector<uint8_t> dst(cw * ch * 4, 0);

    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 2, 1);
    node.layout = bg::LayerLayout::Identity(2, 1);
    node.layout.position_x = 2;
    node.layout.position_y = 1;
    node.layout.rotation_deg = 90.0f;
    bg::MixInput input{cw, ch, {node}};

    bg::CpuLayerMixer mixer;
    CHECK(mixer.IsSupported(input), "90-degree rotation rejected");
    mixer.Mix(input, dst.data());

    uint32_t top = 0;
    uint32_t bottom = 0;
    std::memcpy(&top, &dst[(1 * cw + 1) * 4], 4);
    std::memcpy(&bottom, &dst[(2 * cw + 1) * 4], 4);
    CHECK_EQ(top, kOpaqueRed, "rotated first pixel misplaced");
    CHECK_EQ(bottom, kOpaqueGreen, "rotated second pixel misplaced");
}

TEST(MultipleMasksAreIntersected) {
    const int w = 5;
    std::vector<uint8_t> src(w * 4, 0);
    FillSolid(src, w, 1, kOpaqueRed);
    std::vector<uint8_t> dst(w * 4, 0);

    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, w, 1);
    node.layout = bg::LayerLayout::Identity(w, 1);
    node.masks.push_back({bg::MaskMode::Normal, {1, 0, 3, 1}});
    node.masks.push_back({bg::MaskMode::Inverted, {2, 0, 1, 1}});
    bg::MixInput input{w, 1, {node}};

    bg::CpuLayerMixer mixer;
    mixer.Mix(input, dst.data());
    for (int x = 0; x < w; ++x) {
        uint32_t px = 0;
        std::memcpy(&px, &dst[x * 4], 4);
        const bool expected = x == 1 || x == 3;
        CHECK_EQ(px, expected ? kOpaqueRed : 0u,
                 "nested mask intersection mismatch");
    }
}

TEST(InvalidBufferAndNanTransformFallback) {
    bg::LayerNode node{};
    node.layout = bg::LayerLayout::Identity(1, 1);
    node.layout.rotation_deg = std::nanf("");
    bg::MixInput input{1, 1, {node}};
    bg::CpuLayerMixer mixer;
    CHECK(!mixer.IsSupported(input), "invalid buffer/NaN accepted");
    const auto reasons = mixer.FallbackReasons(input);
    bool saw_buffer = false;
    bool saw_non_finite = false;
    for (const auto reason : reasons) {
        saw_buffer = saw_buffer || reason == bg::FallbackReason::InvalidBuffer;
        saw_non_finite =
            saw_non_finite || reason == bg::FallbackReason::NonFiniteTransform;
    }
    CHECK(saw_buffer, "missing invalid-buffer fallback");
    CHECK(saw_non_finite, "missing non-finite fallback");
}

TEST(MixFailsClosedWhenAnyLayerIsUnsupported) {
    std::vector<uint8_t> red(4, 0);
    SetPixel(red, 1, 0, 0, 0, 0, 255, 255);
    std::vector<uint8_t> green(4, 0);
    SetPixel(green, 1, 0, 0, 0, 255, 0, 255);

    bg::LayerNode valid{};
    valid.buffer = MakeBufferRef(red, 1, 1);
    valid.layout = bg::LayerLayout::Identity(1, 1);
    bg::LayerNode singular{};
    singular.buffer = MakeBufferRef(green, 1, 1);
    singular.layout = bg::LayerLayout::Identity(1, 1);
    singular.layout.affine = bg::LayerAffine{1, 2, 0, 2, 4, 0};

    bg::MixInput input{1, 1, {valid, singular}};
    bg::CpuLayerMixer mixer;
    CHECK(!mixer.IsSupported(input), "singular graph accepted");
    std::vector<uint8_t> dst(4, 0);
    mixer.Mix(input, dst.data());
    uint32_t pixel = 0;
    std::memcpy(&pixel, dst.data(), 4);
    CHECK_EQ(pixel, 0u, "unsupported graph produced a partial frame");
}

TEST(HugeAffineBoundsAreRejectedBeforeMix) {
    std::vector<uint8_t> src(4, 0xFF);
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 1, 1);
    node.layout = bg::LayerLayout::Identity(1, 1);
    node.layout.affine = bg::LayerAffine{
        1, 0, static_cast<float>(std::numeric_limits<int32_t>::max()) * 2.0f,
        0, 1, 0,
    };
    bg::MixInput input{1, 1, {node}};
    bg::CpuLayerMixer mixer;
    CHECK(!mixer.IsSupported(input), "unrepresentable affine bounds accepted");
}

TEST(HalfLayerOpacityPreservesPremultipliedContract) {
    std::vector<uint8_t> src(4, 0);
    SetPixel(src, 1, 0, 0, 0, 0, 255, 255);
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 1, 1);
    node.layout = bg::LayerLayout::Identity(1, 1);
    node.opacity = 0.5f;
    bg::MixInput input{1, 1, {node}};
    std::vector<uint8_t> dst(4, 0);

    bg::CpuLayerMixer{}.Mix(input, dst.data());
    CHECK_EQ(dst[0], 0, "blue mismatch");
    CHECK_EQ(dst[1], 0, "green mismatch");
    CHECK_EQ(dst[2], 128, "premultiplied red mismatch");
    CHECK_EQ(dst[3], 128, "alpha mismatch");
}

TEST(PartialCanvasClipUsesVisibleSourcePixels) {
    std::vector<uint8_t> src(8, 0);
    SetPixel(src, 2, 0, 0, 0, 0, 255, 255);
    SetPixel(src, 2, 1, 0, 0, 255, 0, 255);
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 2, 1);
    node.layout = bg::LayerLayout::Identity(2, 1);
    node.layout.position_x = -1;
    bg::MixInput input{1, 1, {node}};
    std::vector<uint8_t> dst(4, 0);

    bg::CpuLayerMixer{}.Mix(input, dst.data());
    uint32_t pixel = 0;
    std::memcpy(&pixel, dst.data(), 4);
    CHECK_EQ(pixel, kOpaqueGreen, "partial clip sampled the wrong source pixel");
}

TEST(ScaleDownNearestUsesPixelCenters) {
    std::vector<uint8_t> src(4 * 2 * 4, 0);
    SetPixel(src, 4, 0, 0, 0, 0, 255, 255);
    SetPixel(src, 4, 1, 1, 0, 255, 0, 255);
    SetPixel(src, 4, 3, 1, 255, 0, 0, 255);
    bg::LayerNode node{};
    node.buffer = MakeBufferRef(src, 4, 2);
    node.layout = bg::LayerLayout::Identity(4, 2);
    node.layout.scale_x = 0.5f;
    node.layout.scale_y = 0.5f;
    bg::MixInput input{2, 1, {node}};
    std::vector<uint8_t> dst(8, 0);

    bg::CpuLayerMixer{}.Mix(input, dst.data());
    uint32_t left = 0;
    uint32_t right = 0;
    std::memcpy(&left, dst.data(), 4);
    std::memcpy(&right, dst.data() + 4, 4);
    CHECK_EQ(left, kOpaqueGreen, "scale-down left sample mismatch");
    CHECK_EQ(right, kOpaqueBlue, "scale-down right sample mismatch");
}

TEST(IntegerTranslationFastPathMatchesAffinePath) {
    std::vector<uint8_t> src(2 * 2 * 4, 0);
    SetPixel(src, 2, 0, 0, 0, 0, 255, 255);
    SetPixel(src, 2, 1, 0, 0, 255, 0, 255);
    SetPixel(src, 2, 0, 1, 255, 0, 0, 255);
    SetPixel(src, 2, 1, 1, 255, 255, 255, 255);

    bg::LayerNode fast{};
    fast.buffer = MakeBufferRef(src, 2, 2);
    fast.layout = bg::LayerLayout::Identity(2, 2);
    fast.layout.position_x = 2;
    fast.layout.position_y = 1;
    bg::LayerNode affine = fast;
    affine.layout.position_x = 0;
    affine.layout.position_y = 0;
    affine.layout.affine = bg::LayerAffine{1, 0, 2, 0, 1, 1};

    std::vector<uint8_t> fast_dst(5 * 4 * 4, 0);
    std::vector<uint8_t> affine_dst(5 * 4 * 4, 0);
    bg::CpuLayerMixer mixer;
    mixer.Mix(bg::MixInput{5, 4, {fast}}, fast_dst.data());
    mixer.Mix(bg::MixInput{5, 4, {affine}}, affine_dst.data());
    CHECK(std::memcmp(fast_dst.data(), affine_dst.data(), fast_dst.size()) == 0,
          "integer fast path diverges from affine reference");
}

TEST(SimdSpanIsPixelExactForPremultipliedInputsAndTails) {
    constexpr size_t kPixels = 17;
    const auto mul_div_255 = [](uint16_t value) {
        const uint16_t t = static_cast<uint16_t>(value + 128);
        return static_cast<uint8_t>((t + (t >> 8)) >> 8);
    };
    for (const uint8_t opacity : {uint8_t{1}, uint8_t{37}, uint8_t{128},
                                  uint8_t{255}}) {
        std::vector<uint8_t> src(kPixels * 4);
        std::vector<uint8_t> expected(kPixels * 4);
        for (size_t pixel = 0; pixel < kPixels; ++pixel) {
            const uint8_t src_a = static_cast<uint8_t>((pixel * 31 + 17) & 0xFF);
            const uint8_t dst_a = static_cast<uint8_t>((pixel * 47 + 53) & 0xFF);
            src[pixel * 4 + 3] = src_a;
            expected[pixel * 4 + 3] = dst_a;
            for (size_t channel = 0; channel < 3; ++channel) {
                src[pixel * 4 + channel] = static_cast<uint8_t>(
                    (pixel * (channel + 3) * 13) % (src_a + 1));
                expected[pixel * 4 + channel] = static_cast<uint8_t>(
                    (pixel * (channel + 5) * 11) % (dst_a + 1));
            }
        }
        std::vector<uint8_t> actual = expected;
        for (size_t pixel = 0; pixel < kPixels; ++pixel) {
            uint8_t* dst = expected.data() + pixel * 4;
            const uint8_t* source = src.data() + pixel * 4;
            const uint8_t effective_a = mul_div_255(
                static_cast<uint16_t>(source[3]) * opacity);
            const uint8_t inv_a = static_cast<uint8_t>(255 - effective_a);
            for (size_t channel = 0; channel < 3; ++channel) {
                const int value = mul_div_255(
                    static_cast<uint16_t>(source[channel]) * opacity)
                    + mul_div_255(static_cast<uint16_t>(dst[channel]) * inv_a);
                dst[channel] = static_cast<uint8_t>(std::min(255, value));
            }
            dst[3] = static_cast<uint8_t>(std::min(
                255, static_cast<int>(effective_a)
                    + mul_div_255(static_cast<uint16_t>(dst[3]) * inv_a)));
        }
        bg::SrcOverSpan(actual.data(), src.data(), kPixels, opacity);
        for (size_t byte = 0; byte < actual.size(); ++byte) {
            if (actual[byte] != expected[byte]) {
                std::fprintf(
                    stderr,
                    "  SIMD mismatch opacity=%u pixel=%zu channel=%zu "
                    "actual=%u expected=%u\n",
                    opacity, byte / 4, byte % 4, actual[byte], expected[byte]);
                break;
            }
        }
        CHECK(std::memcmp(actual.data(), expected.data(), actual.size()) == 0,
              "SIMD span diverges from scalar premultiplied reference");
    }
}

TEST(DirtyRegionsMatchFullRecomposeForMovedLayer) {
    constexpr int32_t kWidth = 64;
    constexpr int32_t kHeight = 32;
    std::vector<uint8_t> background(kWidth * kHeight * 4);
    std::vector<uint8_t> foreground(8 * 8 * 4);
    FillSolid(background, kWidth, kHeight, kOpaqueBlue);
    FillSolid(foreground, 8, 8, kOpaqueRed);

    bg::LayerNode back;
    back.buffer = MakeBufferRef(background, kWidth, kHeight);
    back.layout = bg::LayerLayout::Identity(kWidth, kHeight);
    bg::LayerNode front;
    front.buffer = MakeBufferRef(foreground, 8, 8);
    front.layout = bg::LayerLayout::Identity(8, 8);
    front.layout.position_x = 4;
    bg::MixInput input;
    input.canvas_width = kWidth;
    input.canvas_height = kHeight;
    input.layers = {back, front};

    bg::CpuLayerMixer mixer;
    std::vector<uint8_t> incremental(kWidth * kHeight * 4, 0);
    mixer.Mix(input, incremental.data());
    input.layers[1].layout.position_x = 20;
    const std::vector<bg::LayerRect> dirty = {
        {4, 0, 8, 8},
        {20, 0, 8, 8},
    };
    for (const auto& rect : dirty) {
        for (int32_t y = rect.y; y < rect.y + rect.height; ++y) {
            std::memset(
                incremental.data()
                    + (static_cast<size_t>(y) * kWidth + rect.x) * 4,
                0, static_cast<size_t>(rect.width) * 4);
        }
    }
    CHECK(mixer.MixRegions(input, incremental.data(), dirty),
          "dirty-region mix rejected supported input");

    std::vector<uint8_t> expected(kWidth * kHeight * 4, 0);
    mixer.Mix(input, expected.data());
    CHECK(std::memcmp(
              incremental.data(), expected.data(), expected.size()) == 0,
          "dirty-region output diverges from full recompose");
}

TEST(ParallelMixerCoversBandBoundariesExactly) {
    constexpr int32_t kSize = 512;
    std::vector<uint8_t> source(static_cast<size_t>(kSize) * kSize * 4);
    for (int32_t y = 0; y < kSize; ++y) {
        for (int32_t x = 0; x < kSize; ++x) {
            uint8_t* pixel =
                source.data() + (static_cast<size_t>(y) * kSize + x) * 4;
            pixel[0] = static_cast<uint8_t>(x & 0xFF);
            pixel[1] = static_cast<uint8_t>(y & 0xFF);
            pixel[2] = static_cast<uint8_t>((x + y) & 0xFF);
            pixel[3] = 0xFF;
        }
    }
    bg::LayerNode layer;
    layer.buffer = {source.data(), kSize, kSize, kSize * 4};
    layer.layout.source_w = kSize;
    layer.layout.source_h = kSize;
    bg::MaskOp hole;
    hole.mode = bg::MaskMode::Inverted;
    hole.rect = {100, 120, 300, 270};
    layer.masks.push_back(hole);
    bg::MixInput input;
    input.canvas_width = kSize;
    input.canvas_height = kSize;
    input.layers.push_back(layer);
    std::vector<uint8_t> output(source.size(), 0);
    bg::CpuLayerMixer mixer;
    mixer.Mix(input, output.data());

    for (int32_t y = 0; y < kSize; ++y) {
        for (int32_t x = 0; x < kSize; ++x) {
            const bool masked = x >= 100 && x < 400 && y >= 120 && y < 390;
            const size_t offset =
                (static_cast<size_t>(y) * kSize + x) * 4;
            if (masked) {
                CHECK(output[offset + 3] == 0,
                      "parallel mask hole contains a pixel");
            } else {
                CHECK(std::memcmp(
                          output.data() + offset,
                          source.data() + offset, 4) == 0,
                      "parallel band missed or corrupted a pixel");
            }
        }
    }
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
