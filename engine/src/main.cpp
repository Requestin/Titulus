// engine/src/main.cpp — bg_engine entry point (DEVELOPMENT_PROMPT §9.3, §9.5).
//
// One process = one channel = one consumer. Reimplemented by reference from
// CasparCG shell/main.cpp + modules/html lifecycle (CASPARRCG_PORTING.md §2).
//
// Pipeline:
//   CefInitialize -> CreateBrowser(channel.html) -> OnPaint(BGRA) -> FrameRing
//   main loop: pump CEF, pull latest frame from ring, deliver to Consumer,
//              record cadence into Stats.

#include "config.h"
#include "engine_app.h"
#include "engine_client.h"
#include "consumers/consumer.h"
#include "consumers/ffmpeg_consumer.h"
#include "consumers/null_consumer.h"
#include "consumers/pipe_consumer.h"
#include "consumers/preview_writer.h"
#if defined(BG_ENABLE_DECKLINK)
#include "consumers/decklink_consumer.h"
#endif
#include "frame_ring.h"
#include "message_pump.h"
#include "stats.h"

#include "include/cef_browser.h"
#include "include/cef_command_line.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <memory>
#include <string>
#include <thread>

namespace {

std::string ts() {
    std::time_t t = std::time(nullptr);
    char buf[24];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", std::gmtime(&t));
    return buf;
}

// Timestamped log line to stdout. Named BG_LOG to avoid a clash with CEF's
// own BG_LOG(severity) macro (cef_logging.h).
void BG_LOG(const std::string& msg) {
    std::printf("[%s bg_engine] %s\n", ts().c_str(), msg.c_str());
}

bg::Config cfg;
bg::Stats stats;
bg::FrameRing ring;
std::unique_ptr<bg::Consumer> consumer;
std::atomic<bool> browser_ready{false};
std::atomic<uint64_t> paint_seq{0};
// Track the previous paint sequence so we only record a stat / deliver a frame
// when OnPaint actually produced new pixels (DEVELOPMENT_PROMPT §9.7).
uint64_t last_delivered_seq = 0;
std::chrono::steady_clock::time_point last_paint_time;
bool have_last_paint = false;

void on_paint(const uint8_t* bgra, int width, int height) {
    ring.Copy(bgra, width, height);
    paint_seq.fetch_add(1, std::memory_order_release);
}

void on_ready(bool /*ready*/) {
    browser_ready.store(true, std::memory_order_release);
}

std::unique_ptr<bg::Consumer> make_consumer() {
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
            std::fprintf(stderr, "bg_engine: consumer '%s' not built into this binary; "
                                 "using null.\n", bg::ConsumerLabel(cfg.consumer));
            return std::make_unique<bg::NullConsumer>();
#endif
        case bg::ConsumerKind::Stream:
            return std::make_unique<bg::FfmpegConsumer>(cfg.stream_url);
    }
    return std::make_unique<bg::NullConsumer>();
}

}  // namespace

int main(int argc, char** argv) {
    // CEF sub-process guard MUST run before our own arg parsing: Chromium spawns
    // helper processes (zygote/utility/renderer) by re-executing this binary
    // with extra --type=... args that our parser doesn't understand. CefExecuteProcess
    // intercepts those and returns >=0 so the helper exits here. Only the browser
    // process gets exit_code < 0 and continues. (CasparCG html.cpp:216-225.)
    CefMainArgs main_args(argc, argv);
    {
        CefRefPtr<CefApp> app;
        int exit_code = CefExecuteProcess(main_args, app, nullptr);
        if (exit_code >= 0) return exit_code;
    }

    if (!cfg.Parse(argc, argv)) {
        return 2;
    }
    BG_LOG("starting " + cfg.Describe());

    if (!bg::EngineInit(main_args, cfg.cache_dir)) {
        std::fprintf(stderr, "bg_engine: CefInitialize failed\n");
        return 1;
    }

    consumer = make_consumer();
    if (!consumer->Start(cfg.width, cfg.height, cfg.fps)) {
        std::fprintf(stderr, "bg_engine: consumer '%s' Start() failed\n", consumer->Label());
        bg::EngineShutdown();
        return 1;
    }

    // Build the OSR browser pointing at channel.html.
    CefRefPtr<bg::EngineClient> client = new bg::EngineClient(
        cfg.width, cfg.height, on_paint, on_ready);

    CefWindowInfo window_info;
    window_info.SetAsWindowless(0);  // OSR, no native window
    CefBrowserSettings browser_settings;
    // Pin the internal frame rate to the channel fps so begin-frame scheduling
    // drives painting at the channel cadence (CasparCG html_producer.cpp:666).
    browser_settings.windowless_frame_rate = cfg.fps;

    const std::string url = cfg.url;
    CefBrowserHost::CreateBrowser(window_info, client.get(), url,
                                  browser_settings, nullptr, nullptr);

    BG_LOG("browser created, loading " + url);

    bg::MessagePump pump(cfg.fps);
    const uint64_t expected_us = pump.target_interval_us();
    const auto start = std::chrono::steady_clock::now();
    uint64_t last_stats_report = 0;
    int exit_code = 0;

    // Main loop: pump CEF, deliver latest frame to consumer, record cadence.
    while (true) {
        const int64_t sleep_us = pump.Tick(/*out_painted=*/false);

        // Deliver the latest painted frame to the consumer, but only when a new
        // OnPaint actually arrived (avoid double-counting / re-delivering).
        const uint64_t cur_seq = paint_seq.load(std::memory_order_acquire);
        if (browser_ready.load(std::memory_order_acquire) && cur_seq != last_delivered_seq) {
            last_delivered_seq = cur_seq;
            ring.Latest([&](const bg::Frame& f) {
                if (consumer) consumer->OnFrame(f);
            });

            // Record cadence against the previous paint time.
            const auto now = std::chrono::steady_clock::now();
            uint64_t interval_us = 0;
            if (have_last_paint) {
                interval_us = std::chrono::duration_cast<std::chrono::microseconds>(
                    now - last_paint_time).count();
            }
            stats.RecordFrame(interval_us, expected_us);
            last_paint_time = now;
            have_last_paint = true;
        }

        // Periodic stats progress.
        const uint64_t elapsed_s = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - start).count();
        if (cfg.stats_interval_sec > 0 &&
            elapsed_s >= last_stats_report + static_cast<uint64_t>(cfg.stats_interval_sec)) {
            last_stats_report = elapsed_s;
            BG_LOG(stats.Progress());
        }

        // Duration cap (0 = infinite).
        if (cfg.duration_sec > 0 && elapsed_s >= static_cast<uint64_t>(cfg.duration_sec)) {
            BG_LOG("duration reached, shutting down");
            break;
        }

        // Consumer requested a controlled process restart (e.g. DeckLink profile
        // switch). Non-zero code is propagated to run-channel.sh supervisor.
        if (consumer) {
            const int requested = consumer->PollExitCode();
            if (requested != 0) {
                exit_code = requested;
                BG_LOG("consumer requested exit code " + std::to_string(exit_code));
                break;
            }
        }

        if (sleep_us > 0) std::this_thread::sleep_for(std::chrono::microseconds(sleep_us));
    }

    // Shutdown: close the browser, stop the consumer, print the SUMMARY line
    // that bench/run-bench.sh parses.
    {
        CefRefPtr<CefBrowser> browser = nullptr;
        client->set_closing();
    }
    if (consumer) consumer->Stop();
    BG_LOG(stats.Summary());
    bg::EngineShutdown();
    return exit_code;
}
