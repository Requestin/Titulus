// engine/bench/layered_compositor_bench.cpp
//
// POC bench for the Doc02 layered compositor. Runs the scalar mixer on a
// synthetic operator-aware snapshot derived from `tests/templates/test1.json`
// (via the runtime's `classifyRenderGraph`, encoded through the BGGRAPH
// protocol, parsed by the engine) and measures ns/frame for the mixer path
// against a synthetic monolith baseline that writes the whole canvas from one
// buffer.
//
// This is intentionally synthetic: the CEF raster cost is already known from
// Phase 18 and is not measured here. The point is to show that, with cached
// source bitmaps, the per-frame cost of the operator-aware mixer is dominated
// by memory bandwidth and is cheap enough to deserve a paired K2 review.
//
// Gate: build with -DBG_BUILD_LAYERED_COMPOSITOR_BENCH=ON (off by default so
// the bench never pollutes the production bg_engine build).

#include "../src/compositor/layered_compositor.h"
#include "../src/compositor/synthetic_snapshot.h"
#include "../src/mixer/graph_message_parser.h"
#include "../src/mixer/protocol_types.h"
#include "../src/mixer/render_graph_store.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct Stats {
    int64_t min_ns = INT64_MAX;
    int64_t max_ns = 0;
    int64_t sum_ns = 0;
    int64_t count = 0;

    void Add(int64_t v) {
        min_ns = std::min(min_ns, v);
        max_ns = std::max(max_ns, v);
        sum_ns += v;
        ++count;
    }

    void Print(const char* label) const {
        if (count == 0) {
            std::printf("  %-32s (no samples)\n", label);
            return;
        }
        const double mean_ns = static_cast<double>(sum_ns) / count;
        const double mean_us = mean_ns / 1000.0;
        std::printf("  %-32s n=%-5lld mean=%7.2fus  min=%7.2fus  max=%7.2fus\n",
                    label, static_cast<long long>(count), mean_us,
                    static_cast<double>(min_ns) / 1000.0,
                    static_cast<double>(max_ns) / 1000.0);
    }
};

// Loads a BGGRAPH v1 snapshot file produced by
// `node engine/research/p19/emit_test1_graph.mjs`. The file is one
// `BGGRAPH v1 <json>` line, possibly with a trailing newline. Returns an
// empty optional on failure.
std::optional<bg::ProtocolSnapshot> LoadGraphFile(const std::string& path) {
    std::ifstream in(path);
    if (!in) return std::nullopt;
    std::stringstream ss;
    ss << in.rdbuf();
    std::string raw = ss.str();
    while (!raw.empty() && (raw.back() == '\n' || raw.back() == '\r'
                            || raw.back() == ' ' || raw.back() == '\t')) {
        raw.pop_back();
    }
    auto result = bg::ParseGraphMessage(raw);
    if (result.status != bg::GraphParseStatus::Ok) return std::nullopt;
    return std::move(result.snapshot);
}

int64_t NowNs() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

void MemsetFrame(uint8_t* dst, int w, int h, uint8_t v) {
    const size_t bytes = static_cast<size_t>(w) * h * 4;
    std::memset(dst, v, bytes);
}

}  // namespace

int main(int argc, char** argv) {
    const char* graph_path =
        argc > 1 ? argv[1] : "engine/research/results/p19/doc02-20260715/graph/test1.bgraph";
    const int iterations = argc > 2 ? std::atoi(argv[2]) : 200;
    const int canvas_w = argc > 3 ? std::atoi(argv[3]) : 1920;
    const int canvas_h = argc > 4 ? std::atoi(argv[4]) : 1080;

    std::printf("Doc02 layered compositor POC bench\n");
    std::printf("  graph:    %s\n", graph_path);
    std::printf("  iters:    %d\n", iterations);
    std::printf("  canvas:   %dx%d\n", canvas_w, canvas_h);

    auto snapshot = LoadGraphFile(graph_path);
    if (!snapshot) {
        std::fprintf(stderr,
                     "Failed to load BGGRAPH snapshot. Run "
                     "`node engine/research/p19/emit_test1_graph.mjs %s` "
                     "first.\n",
                     graph_path);
        return 2;
    }
    std::printf("  layers:   %zu\n", snapshot->layers.size());

    auto synthetic = bg::compositor::BuildSyntheticSnapshot(*snapshot);

    std::vector<uint8_t> dst_frame(
        static_cast<size_t>(canvas_w) * canvas_h * 4, 0);

    bg::compositor::LayeredCompositor compositor;
    Stats layered_stats;
    Stats monolith_stats;

    // Warm-up: first call may fault in pages; we don't want that in the
    // measurement window.
    for (int i = 0; i < 16; ++i) {
        MemsetFrame(dst_frame.data(), canvas_w, canvas_h, 0);
        compositor.Composite(synthetic, canvas_w, canvas_h, dst_frame.data());
    }

    // Layered path: scalar mixer over cached synthetic sources.
    for (int i = 0; i < iterations; ++i) {
        MemsetFrame(dst_frame.data(), canvas_w, canvas_h, 0);
        const auto t0 = NowNs();
        auto res = compositor.Composite(synthetic, canvas_w, canvas_h,
                                        dst_frame.data());
        const auto t1 = NowNs();
        if (!res.ok) {
            std::fprintf(stderr, "Layered path returned fallback: ");
            for (const auto& r : res.fallback_reasons) std::fprintf(stderr, "%s ", r.c_str());
            std::fprintf(stderr, "\n");
            return 3;
        }
        layered_stats.Add(t1 - t0);
    }

    // Synthetic monolith baseline: one full-canvas memset + memcpy of the same
    // byte budget as a single CEF OnPaint would deliver. This is the cheapest
    // possible monolith; real CEF cost is higher (see Phase 18 reports).
    const size_t frame_bytes = dst_frame.size();
    std::vector<uint8_t> monolith_src(frame_bytes, 0xff);
    for (int i = 0; i < iterations; ++i) {
        const auto t0 = NowNs();
        std::memcpy(dst_frame.data(), monolith_src.data(), frame_bytes);
        const auto t1 = NowNs();
        monolith_stats.Add(t1 - t0);
    }

    std::printf("\nResults\n");
    layered_stats.Print("layered_mixer_scalar");
    monolith_stats.Print("monolith_memcpy_baseline");
    const double layered_mean_us =
        static_cast<double>(layered_stats.sum_ns) / layered_stats.count / 1000.0;
    const double monolith_mean_us =
        static_cast<double>(monolith_stats.sum_ns) / monolith_stats.count / 1000.0;
    std::printf("\n  layered_mean_us = %.2f\n", layered_mean_us);
    std::printf("  monolith_mean_us = %.2f\n", monolith_mean_us);
    if (layered_mean_us > 0) {
        std::printf("  ratio layered/monolith = %.3f\n",
                    layered_mean_us / monolith_mean_us);
    }
    return 0;
}
