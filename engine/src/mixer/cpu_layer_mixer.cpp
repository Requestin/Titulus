// engine/src/mixer/cpu_layer_mixer.cpp

#include "cpu_layer_mixer.h"

#include "affine_sampler.h"
#include "mask_ops.h"
#include "simd_blend.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <thread>

namespace bg {

namespace {

inline uint8_t ClampU8(int v) {
    return v < 0 ? 0 : (v > 255 ? 255 : static_cast<uint8_t>(v));
}

inline int MulDiv255(int a, int b) {
    const int product = a * b + 128;
    return (product + (product >> 8)) >> 8;
}

inline void SrcOverPixel(uint8_t* dst, const uint8_t* src,
                         uint8_t opacity) {
    // CEF OSR OnPaint is premultiplied BGRA. Layer opacity therefore scales
    // both source alpha and already-premultiplied color before src-over.
    if (opacity == 255 && src[3] == 255) {
        std::memcpy(dst, src, 4);
        return;
    }
    const int sa = MulDiv255(src[3], opacity);
    if (sa == 0) return;
    const int inv_sa = 255 - sa;
    for (int c = 0; c < 3; ++c) {
        const int src_c =
            opacity == 255 ? src[c] : MulDiv255(src[c], opacity);
        const int dst_c = MulDiv255(dst[c], inv_sa);
        dst[c] = ClampU8(src_c + dst_c);
    }
    const int out_a = sa + MulDiv255(dst[3], inv_sa);
    dst[3] = ClampU8(out_a);
}

bool IsFiniteLegacyLayout(const LayerLayout& layout) {
    return std::isfinite(layout.scale_x) && std::isfinite(layout.scale_y)
        && std::isfinite(layout.rotation_deg)
        && std::isfinite(layout.anchor_x) && std::isfinite(layout.anchor_y);
}

bool IsFiniteAffine(const LayerAffine& affine) {
    return std::isfinite(affine.m00) && std::isfinite(affine.m01)
        && std::isfinite(affine.m02) && std::isfinite(affine.m10)
        && std::isfinite(affine.m11) && std::isfinite(affine.m12);
}

struct XSpan {
    int32_t begin = 0;
    int32_t end = 0;
};

constexpr size_t kMaxMaskSpans = 64;

bool VisibleMaskSpans(int32_t x0, int32_t x1, int32_t y,
                      const std::vector<MaskOp>& masks,
                      std::array<XSpan, kMaxMaskSpans>& spans,
                      size_t& span_count) {
    spans[0] = {x0, x1};
    span_count = x0 < x1 ? 1 : 0;
    for (const auto& mask : masks) {
        if (mask.rect.width <= 0 || mask.rect.height <= 0) {
            if (mask.mode == MaskMode::Normal) span_count = 0;
            continue;
        }
        const int64_t mask_bottom =
            static_cast<int64_t>(mask.rect.y) + mask.rect.height;
        const bool row_inside =
            y >= mask.rect.y && static_cast<int64_t>(y) < mask_bottom;
        if (mask.mode == MaskMode::Normal) {
            if (!row_inside) {
                span_count = 0;
                continue;
            }
            const int64_t mask_right =
                static_cast<int64_t>(mask.rect.x) + mask.rect.width;
            size_t next_count = 0;
            for (size_t i = 0; i < span_count; ++i) {
                const int64_t begin = std::max<int64_t>(
                    spans[i].begin, mask.rect.x);
                const int64_t end = std::min<int64_t>(
                    spans[i].end, mask_right);
                if (begin < end) {
                    spans[next_count++] = {
                        static_cast<int32_t>(begin),
                        static_cast<int32_t>(end),
                    };
                }
            }
            span_count = next_count;
            continue;
        }
        if (!row_inside) continue;

        const int64_t mask_left = mask.rect.x;
        const int64_t mask_right =
            static_cast<int64_t>(mask.rect.x) + mask.rect.width;
        std::array<XSpan, kMaxMaskSpans> next{};
        size_t next_count = 0;
        for (size_t i = 0; i < span_count; ++i) {
            const XSpan span = spans[i];
            if (span.begin < mask_left) {
                if (next_count >= next.size()) return false;
                next[next_count++] = {
                    span.begin,
                    static_cast<int32_t>(std::min<int64_t>(
                        span.end, mask_left)),
                };
            }
            if (span.end > mask_right) {
                if (next_count >= next.size()) return false;
                next[next_count++] = {
                    static_cast<int32_t>(std::max<int64_t>(
                        span.begin, mask_right)),
                    span.end,
                };
            }
        }
        spans = next;
        span_count = next_count;
    }
    return true;
}

}  // namespace

struct CpuLayerMixer::WorkerPool {
    static constexpr size_t kWorkerCount = 3;

    explicit WorkerPool(CpuLayerMixer& owner) : owner_(owner) {
        for (size_t index = 0; index < workers_.size(); ++index) {
            workers_[index] = std::thread([this, index] { Run(index + 1); });
        }
    }

    ~WorkerPool() {
        {
            std::lock_guard lock(mutex_);
            stop_ = true;
        }
        work_ready_.notify_all();
        for (auto& worker : workers_) worker.join();
    }

    void Mix(const MixInput& input, uint8_t* dst) {
        {
            std::lock_guard lock(mutex_);
            input_ = &input;
            dst_ = dst;
            completed_ = 0;
            ++generation_;
        }
        work_ready_.notify_all();
        CompositeBand(input, dst, 0);
        std::unique_lock lock(mutex_);
        work_done_.wait(lock, [this] { return completed_ == kWorkerCount; });
    }

  private:
    void CompositeBand(const MixInput& input, uint8_t* dst, size_t band) {
        constexpr int32_t kBandCount =
            static_cast<int32_t>(kWorkerCount + 1);
        const int32_t band_height =
            (input.canvas_height + kBandCount - 1) / kBandCount;
        const int32_t y0 =
            std::min(input.canvas_height, static_cast<int32_t>(band) * band_height);
        const int32_t y1 = std::min(input.canvas_height, y0 + band_height);
        owner_.CompositeRange(
            input, dst, 0, y0, input.canvas_width, y1);
    }

    void Run(size_t band) {
        uint64_t observed_generation = 0;
        for (;;) {
            const MixInput* input = nullptr;
            uint8_t* dst = nullptr;
            {
                std::unique_lock lock(mutex_);
                work_ready_.wait(lock, [this, observed_generation] {
                    return stop_ || generation_ != observed_generation;
                });
                if (stop_) return;
                observed_generation = generation_;
                input = input_;
                dst = dst_;
            }
            CompositeBand(*input, dst, band);
            {
                std::lock_guard lock(mutex_);
                ++completed_;
            }
            work_done_.notify_one();
        }
    }

    CpuLayerMixer& owner_;
    std::array<std::thread, kWorkerCount> workers_;
    std::mutex mutex_;
    std::condition_variable work_ready_;
    std::condition_variable work_done_;
    const MixInput* input_ = nullptr;
    uint8_t* dst_ = nullptr;
    uint64_t generation_ = 0;
    size_t completed_ = 0;
    bool stop_ = false;
};

CpuLayerMixer::CpuLayerMixer() = default;
CpuLayerMixer::~CpuLayerMixer() = default;

bool CpuLayerMixer::IsSupported(const MixInput& input) const {
    return FallbackReasons(input).empty();
}

std::vector<FallbackReason> CpuLayerMixer::FallbackReasons(
    const MixInput& input) const {
    std::vector<FallbackReason> reasons;
    for (const auto& node : input.layers) {
        if (!std::isfinite(node.opacity)
            || (node.layout.affine && !IsFiniteAffine(*node.layout.affine))
            || (!node.layout.affine && !IsFiniteLegacyLayout(node.layout))) {
            reasons.push_back(FallbackReason::NonFiniteTransform);
        }
        if (!node.layout.affine
            && (node.layout.scale_x <= 0.0f || node.layout.scale_y <= 0.0f)) {
            reasons.push_back(FallbackReason::NonPositiveScale);
        }
        if (node.layout.affine) {
            const float det = node.layout.affine->m00 * node.layout.affine->m11
                - node.layout.affine->m01 * node.layout.affine->m10;
            if (!std::isfinite(det)
                || std::abs(det) <= std::numeric_limits<float>::epsilon()) {
                reasons.push_back(FallbackReason::SingularTransform);
            }
        }
        if (!BuildAffineMapping(node.layout).supported) {
            reasons.push_back(FallbackReason::OversizedLayer);
        }
        for (const auto& mask : node.masks) {
            if (!IsMaskSupported(mask)) {
                reasons.push_back(FallbackReason::NonRectMaskShape);
            }
        }
        const int64_t src_pixels =
            static_cast<int64_t>(node.buffer.width) * node.buffer.height;
        if (src_pixels <= 0
            || src_pixels > static_cast<int64_t>(64 * 1024 * 1024)) {
            reasons.push_back(FallbackReason::OversizedLayer);
        }
        const int64_t minimum_stride =
            static_cast<int64_t>(node.buffer.width) * 4;
        const int64_t stride = node.buffer.stride_bytes != 0
            ? node.buffer.stride_bytes
            : minimum_stride;
        if (!node.buffer.data || node.buffer.width <= 0
            || node.buffer.height <= 0 || stride < minimum_stride
            || node.layout.source_w <= 0 || node.layout.source_h <= 0
            || node.layout.source_w > node.buffer.width
            || node.layout.source_h > node.buffer.height) {
            reasons.push_back(FallbackReason::InvalidBuffer);
        }
    }
    return reasons;
}

void CpuLayerMixer::Mix(const MixInput& input, uint8_t* dst) {
    if (!dst || !IsSupported(input)) return;
    MixValidated(input, dst);
}

void CpuLayerMixer::MixValidated(const MixInput& input, uint8_t* dst) {
    constexpr int64_t kParallelThresholdPixels = 512 * 512;
    const int64_t canvas_pixels =
        static_cast<int64_t>(input.canvas_width) * input.canvas_height;
    if (canvas_pixels >= kParallelThresholdPixels) {
        if (!worker_pool_) worker_pool_ = std::make_unique<WorkerPool>(*this);
        worker_pool_->Mix(input, dst);
        return;
    }
    CompositeRange(
        input, dst, 0, 0, input.canvas_width, input.canvas_height);
}

bool CpuLayerMixer::MixRegions(
    const MixInput& input, uint8_t* dst,
    std::span<const LayerRect> regions) {
    if (!dst || !IsSupported(input)) return false;
    for (const auto& region : regions) {
        const int64_t right = static_cast<int64_t>(region.x) + region.width;
        const int64_t bottom = static_cast<int64_t>(region.y) + region.height;
        const int32_t x0 = std::clamp(region.x, 0, input.canvas_width);
        const int32_t y0 = std::clamp(region.y, 0, input.canvas_height);
        const int32_t x1 = static_cast<int32_t>(std::clamp<int64_t>(
            right, 0, input.canvas_width));
        const int32_t y1 = static_cast<int32_t>(std::clamp<int64_t>(
            bottom, 0, input.canvas_height));
        if (x0 >= x1 || y0 >= y1) continue;
        CompositeRange(input, dst, x0, y0, x1, y1);
    }
    return true;
}

void CpuLayerMixer::CompositeRange(
    const MixInput& input, uint8_t* dst,
    int32_t clip_x0, int32_t clip_y0,
    int32_t clip_x1, int32_t clip_y1) {
    for (const auto& node : input.layers) {
        CompositeLayer(
            node, input.canvas_width, input.canvas_height, dst,
            clip_x0, clip_y0, clip_x1, clip_y1);
    }
}

void CpuLayerMixer::CompositeLayer(const LayerNode& node, int32_t canvas_w,
                                   int32_t canvas_h, uint8_t* dst,
                                   int32_t clip_x0, int32_t clip_y0,
                                   int32_t clip_x1, int32_t clip_y1) {
    if (!dst || !node.buffer.data || node.opacity <= 0.0f
        || !std::isfinite(node.opacity)) {
        return;
    }

    const AffineMapping mapping = BuildAffineMapping(node.layout);
    if (!mapping.supported) return;

    const uint8_t opacity_u8 =
        node.opacity >= 1.0f
        ? 255
        : ClampU8(static_cast<int>(std::lround(node.opacity * 255.0f)));

    const int32_t x0 = std::max({mapping.dest_x, 0, clip_x0});
    const int32_t y0 = std::max({mapping.dest_y, 0, clip_y0});
    const int32_t x1 = std::min({
        mapping.dest_x + mapping.dest_w, canvas_w, clip_x1});
    const int32_t y1 = std::min({
        mapping.dest_y + mapping.dest_h, canvas_h, clip_y1});

    const bool translation_only =
        std::abs(mapping.inv00 - 1.0f) < 1e-6f
        && std::abs(mapping.inv01) < 1e-6f
        && std::abs(mapping.inv10) < 1e-6f
        && std::abs(mapping.inv11 - 1.0f) < 1e-6f;
    if (translation_only) {
        const int32_t source_start_x = static_cast<int32_t>(
            std::floor(static_cast<float>(x0) + 0.5f + mapping.inv02));
        const int32_t source_start_y = static_cast<int32_t>(
            std::floor(static_cast<float>(y0) + 0.5f + mapping.inv12));
        const int32_t stride = node.buffer.stride_bytes != 0
            ? node.buffer.stride_bytes
            : node.buffer.width * 4;
        for (int32_t dy = y0; dy < y1; ++dy) {
            const int32_t sy = source_start_y + (dy - y0);
            if (sy < 0 || sy >= node.layout.source_h) continue;
            std::array<XSpan, kMaxMaskSpans> spans{};
            size_t span_count = 0;
            if (!VisibleMaskSpans(
                    x0, x1, dy, node.masks, spans, span_count)) {
                for (int32_t dx = x0; dx < x1; ++dx) {
                    bool survives_masks = true;
                    for (const auto& mask : node.masks) {
                        if (!PixelSurvivesMask(mask, dx, dy)) {
                            survives_masks = false;
                            break;
                        }
                    }
                    if (!survives_masks) continue;
                    const int32_t sx = source_start_x + (dx - x0);
                    if (sx < 0 || sx >= node.layout.source_w) continue;
                    const uint8_t* pixel = node.buffer.data
                        + static_cast<int64_t>(sy) * stride + sx * 4;
                    SrcOverPixel(
                        &dst[(static_cast<int64_t>(dy) * canvas_w + dx) * 4],
                        pixel, opacity_u8);
                }
                continue;
            }
            for (size_t i = 0; i < span_count; ++i) {
                int32_t begin = spans[i].begin;
                int32_t end = spans[i].end;
                int32_t source_x = source_start_x + (begin - x0);
                if (source_x < 0) {
                    begin -= source_x;
                    source_x = 0;
                }
                end = std::min(
                    end, begin + node.layout.source_w - source_x);
                if (begin >= end) continue;
                const uint8_t* source = node.buffer.data
                    + static_cast<int64_t>(sy) * stride + source_x * 4;
                uint8_t* destination =
                    &dst[(static_cast<int64_t>(dy) * canvas_w + begin) * 4];
                SrcOverSpan(
                    destination, source, static_cast<size_t>(end - begin),
                    opacity_u8);
            }
        }
        return;
    }

    const int32_t stride = node.buffer.stride_bytes != 0
        ? node.buffer.stride_bytes
        : node.buffer.width * 4;
    for (int32_t dy = y0; dy < y1; ++dy) {
        std::array<XSpan, kMaxMaskSpans> spans{};
        size_t span_count = 0;
        const bool mask_spans_exact = VisibleMaskSpans(
            x0, x1, dy, node.masks, spans, span_count);
        if (!mask_spans_exact) {
            span_count = 1;
            spans[0] = {x0, x1};
        }
        for (size_t span_index = 0; span_index < span_count; ++span_index) {
            const int32_t begin = spans[span_index].begin;
            const int32_t end = spans[span_index].end;
            const float canvas_x = static_cast<float>(begin) + 0.5f;
            const float canvas_y = static_cast<float>(dy) + 0.5f;
            const float source_x = mapping.inv00 * canvas_x
                + mapping.inv01 * canvas_y + mapping.inv02;
            const float source_y = mapping.inv10 * canvas_x
                + mapping.inv11 * canvas_y + mapping.inv12;
            uint8_t* destination =
                &dst[(static_cast<int64_t>(dy) * canvas_w + begin) * 4];
            if (mask_spans_exact && AffineSrcOverSpan(
                    destination, node.buffer.data, node.layout.source_w,
                    node.layout.source_h, stride, source_x, source_y,
                    mapping.inv00, mapping.inv10,
                    static_cast<size_t>(end - begin), opacity_u8)) {
                continue;
            }
            for (int32_t dx = begin; dx < end; ++dx) {
                if (!mask_spans_exact) {
                    bool survives_masks = true;
                    for (const auto& mask : node.masks) {
                        if (!PixelSurvivesMask(mask, dx, dy)) {
                            survives_masks = false;
                            break;
                        }
                    }
                    if (!survives_masks) continue;
                }
                const float offset = static_cast<float>(dx - begin);
                const int32_t ix = static_cast<int32_t>(
                    std::floor(source_x + offset * mapping.inv00));
                const int32_t iy = static_cast<int32_t>(
                    std::floor(source_y + offset * mapping.inv10));
                if (ix < 0 || iy < 0 || ix >= node.layout.source_w
                    || iy >= node.layout.source_h) {
                    continue;
                }
                const uint8_t* pixel = node.buffer.data
                    + static_cast<int64_t>(iy) * stride + ix * 4;
                SrcOverPixel(
                    &dst[(static_cast<int64_t>(dy) * canvas_w + dx) * 4],
                    pixel, opacity_u8);
            }
        }
    }
}

}  // namespace bg
