// engine/src/vs/main_vs.cpp — bg_vs_engine entry (Unreal / Virtual Studio).
//
// Pipeline: camera producer → chroma → over Unreal BG → consumer (DeckLink/null/…).
// Docs: docs/unreal-vs-mode.md

#include "vs/chroma_keyer.h"
#include "vs/compositor.h"
#include "vs/config_vs.h"
#include "vs/decklink_input_producer.h"
#include "vs/ndi_producer.h"
#include "vs/producer.h"

#include "consumers/consumer.h"
#include "consumers/ffmpeg_consumer.h"
#include "consumers/null_consumer.h"
#include "consumers/pipe_consumer.h"
#include "consumers/preview_writer.h"
#if defined(BG_ENABLE_DECKLINK)
#include "consumers/decklink_consumer.h"
#endif
#include "stats.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <csignal>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> g_stop{false};

void on_signal(int) { g_stop.store(true); }

std::unique_ptr<bg::Consumer> make_consumer(const bg::vs::VsConfig& cfg) {
    switch (cfg.consumer) {
        case bg::ConsumerKind::Null:
            return std::make_unique<bg::NullConsumer>();
        case bg::ConsumerKind::Pipe:
            return std::make_unique<bg::PipeConsumer>(cfg.pipe_out);
        case bg::ConsumerKind::Preview:
            return std::make_unique<bg::PreviewWriter>(cfg.preview_out, cfg.preview_fps);
        case bg::ConsumerKind::Decklink:
#if defined(BG_ENABLE_DECKLINK)
            return std::make_unique<bg::DecklinkConsumer>(cfg.device_index, cfg.display_mode, cfg.keyer);
#else
            std::fprintf(stderr, "bg_vs_engine: decklink not built; using null\n");
            return std::make_unique<bg::NullConsumer>();
#endif
        case bg::ConsumerKind::Stream:
            return std::make_unique<bg::FfmpegConsumer>(cfg.stream_url);
    }
    return std::make_unique<bg::NullConsumer>();
}

}  // namespace

int main(int argc, char** argv) {
    bg::vs::VsConfig cfg;
    if (!cfg.Parse(argc, argv)) return 2;

    std::printf("[bg_vs_engine] starting %s\n", cfg.Describe().c_str());
    std::signal(SIGINT, on_signal);
    std::signal(SIGTERM, on_signal);

    auto cam = bg::vs::MakeCameraProducer(cfg.vs_input_device, cfg.display_mode, cfg.cam_file);
    auto unreal = bg::vs::MakeUnrealProducer(cfg.ndi_source, cfg.bg_file);

    if (!cam->Start(cfg.width, cfg.height, cfg.fps)) {
        std::fprintf(stderr, "bg_vs_engine: camera producer Start failed (%s)\n", cam->Label());
        return 1;
    }
    if (!unreal->Start(cfg.width, cfg.height, cfg.fps)) {
        std::fprintf(stderr, "bg_vs_engine: unreal producer Start failed (%s)\n", unreal->Label());
        cam->Stop();
        return 1;
    }

    auto consumer = make_consumer(cfg);
    if (!consumer->Start(cfg.width, cfg.height, cfg.fps)) {
        std::fprintf(stderr, "bg_vs_engine: consumer Start failed (%s)\n", consumer->Label());
        cam->Stop();
        unreal->Stop();
        return 1;
    }

    bg::vs::ChromaKeyParams key;
    if (cfg.key_color == "blue") {
        key.key_b = 200; key.key_g = 40; key.key_r = 20;
    }
    key.similarity = cfg.similarity;
    key.smoothness = cfg.smoothness;
    key.spill = cfg.spill;

    bg::Stats stats;
    const uint64_t expected_us = static_cast<uint64_t>(1'000'000 / cfg.fps);
    const auto interval = std::chrono::microseconds(expected_us);
    const auto t0 = std::chrono::steady_clock::now();
    uint64_t seq = 0;
    uint64_t last_stats = 0;
    uint64_t last_tick_us = 0;
    bool have_last_tick = false;

    bg::vs::OwnedFrame cam_frame, bg_frame;
    std::vector<uint8_t> keyed;
    std::vector<uint8_t> program;
    keyed.resize(static_cast<size_t>(cfg.width) * static_cast<size_t>(cfg.height) * 4u);
    program.resize(keyed.size());

    // Warm-up: wait briefly for first frames.
    for (int i = 0; i < 50 && !g_stop.load(); ++i) {
        if (cam->Buffer().Seq() > 0 && unreal->Buffer().Seq() > 0) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    while (!g_stop.load()) {
        const auto tick_start = std::chrono::steady_clock::now();
        if (cfg.duration_sec > 0) {
            const auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(tick_start - t0).count();
            if (elapsed >= cfg.duration_sec) break;
        }

        const bool have_cam = cam->Buffer().CopyLatest(cam_frame);
        const bool have_bg = unreal->Buffer().CopyLatest(bg_frame);

        if (have_bg && (cfg.passthrough || !have_cam)) {
            if (bg_frame.width == cfg.width && bg_frame.height == cfg.height) {
                program = bg_frame.bgra;
            }
        } else if (have_cam && have_bg
                   && cam_frame.width == cfg.width && cam_frame.height == cfg.height
                   && bg_frame.width == cfg.width && bg_frame.height == cfg.height) {
            bg::vs::ApplyChromaKeyTo(cam_frame.bgra.data(), keyed.data(),
                                     cfg.width, cfg.height, key);
            bg::vs::CompositeOver(bg_frame.bgra.data(), keyed.data(), program.data(),
                                  cfg.width, cfg.height);
        } else if (have_cam && cam_frame.width == cfg.width && cam_frame.height == cfg.height) {
            std::fill(program.begin(), program.end(), 0);
            bg::vs::ApplyChromaKeyTo(cam_frame.bgra.data(), keyed.data(),
                                     cfg.width, cfg.height, key);
            bg::vs::CompositeOver(program.data(), keyed.data(), program.data(),
                                  cfg.width, cfg.height);
        } else {
            std::fill(program.begin(), program.end(), 0);
        }

        ++seq;
        bg::Frame frame;
        frame.bgra = program.data();
        frame.width = cfg.width;
        frame.height = cfg.height;
        frame.seq = seq;
        consumer->OnFrame(frame);

        const auto tick_end = std::chrono::steady_clock::now();
        const uint64_t now_us = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(tick_end - t0).count());
        if (have_last_tick) {
            stats.RecordFrame(now_us - last_tick_us, expected_us);
        }
        last_tick_us = now_us;
        have_last_tick = true;

        const auto elapsed_sec = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::seconds>(tick_end - t0).count());
        if (cfg.stats_interval_sec > 0
            && elapsed_sec >= last_stats + static_cast<uint64_t>(cfg.stats_interval_sec)) {
            std::printf("[bg_vs_engine] %s\n", stats.Progress().c_str());
            last_stats = elapsed_sec;
        }

        const int exit_req = consumer->PollExitCode();
        if (exit_req != 0) {
            std::fprintf(stderr, "bg_vs_engine: consumer requested exit %d\n", exit_req);
            cam->Stop();
            unreal->Stop();
            consumer->Stop();
            return exit_req;
        }

        const auto slept = std::chrono::steady_clock::now() - tick_start;
        if (slept < interval) std::this_thread::sleep_for(interval - slept);
    }

    std::printf("[bg_vs_engine] %s\n", stats.Summary().c_str());

    consumer->Stop();
    cam->Stop();
    unreal->Stop();
    return 0;
}
