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
#include "frame_log.h"
#include "frame_ring.h"
#include "message_pump.h"
#include "mixer/render_graph_store.h"
#include "paint_sequence_tracker.h"
#include "compositor/live_pipeline.h"
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
#include <vector>

#if defined(__linux__)
#include <pthread.h>
#include <sched.h>
#endif

namespace {

// Phase 11.4: real-time scheduling for the render pump thread, matching
// CasparCG's channel thread (SCHED_FIFO, low priority — common/os/linux/
// thread.cpp in the reference server uses priority 2). Only called for
// DeckLink-driven channels (see main(): gated on decklink_driven) — the
// Browser/OBS/vMix consumer (null) and every other non-SDI output keeps the
// default scheduling policy untouched, per the explicit constraint that
// nothing in this phase may risk that path.
//
// Low RT priority is safe here because this thread's only job is bounded
// work per tick (pump CEF, deliver a frame, sleep) — it is not a busy loop,
// so it cannot starve the rest of the system the way a runaway RT thread
// would. Failure (no CAP_SYS_NICE / not root) is logged once and otherwise
// ignored: normal scheduling still works, just with more jitter under load,
// which is the pre-11.4 baseline behavior.
void MaybeSetRealtimePumpPriority() {
#if defined(__linux__)
    sched_param param{};
    param.sched_priority = 2;
    const int rc = pthread_setschedparam(pthread_self(), SCHED_FIFO, &param);
    if (rc != 0) {
        std::fprintf(stderr,
                     "bg_engine: SCHED_FIFO priority 2 unavailable (%s) — "
                     "continuing at normal scheduling priority\n",
                     std::strerror(rc));
    }
#endif
}

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
    std::fflush(stdout);
}

bg::Config cfg;
bg::Stats stats;
bg::FrameRing ring;
std::unique_ptr<bg::Consumer> consumer;
std::unique_ptr<bg::FrameLog> frame_log;
std::atomic<bool> browser_ready{false};
std::atomic<uint64_t> paint_seq{0};
// Track the previous paint sequence so we only record a stat / deliver a frame
// when OnPaint actually produced new pixels (DEVELOPMENT_PROMPT §9.7).
uint64_t last_delivered_seq = 0;
std::chrono::steady_clock::time_point last_paint_time;
bool have_last_paint = false;

// Doc02 PR5: composed output buffer for the layered path. Sized on Start.
std::vector<uint8_t> compose_buf;
bg::compositor::LivePipeline* g_live_pipeline = nullptr;

const char* PipelineModeLabel(bg::compositor::PipelineMode mode) {
    using Mode = bg::compositor::PipelineMode;
    switch (mode) {
        case Mode::Disabled: return "disabled";
        case Mode::Capturing: return "capturing";
        case Mode::Composing: return "composing";
        case Mode::FallbackMonolith: return "fallback";
    }
    return "unknown";
}

std::vector<std::string> LayeredTemplateAllowlist() {
    const char* raw = std::getenv("BG_LAYERED_COMPOSITOR_ALLOWLIST");
    if (!raw || *raw == '\0') return {};
    std::vector<std::string> ids;
    std::string value(raw);
    size_t begin = 0;
    while (begin <= value.size()) {
        const size_t comma = value.find(',', begin);
        const size_t end =
            comma == std::string::npos ? value.size() : comma;
        size_t left = begin;
        size_t right = end;
        while (left < right
               && (value[left] == ' ' || value[left] == '\t')) {
            ++left;
        }
        while (right > left
               && (value[right - 1] == ' ' || value[right - 1] == '\t')) {
            --right;
        }
        if (left < right) ids.emplace_back(value.substr(left, right - left));
        if (comma == std::string::npos) break;
        begin = comma + 1;
    }
    return ids;
}

void LogLayeredStats() {
    if (!g_live_pipeline || !g_live_pipeline->enabled()) return;
    const auto& layered = g_live_pipeline->stats();
    BG_LOG(
        "layered_stats mode="
        + std::string(PipelineModeLabel(g_live_pipeline->mode()))
        + " composed=" + std::to_string(layered.composed_frames)
        + " capture_passes=" + std::to_string(layered.capture_passes)
        + " capture_ready=" + std::to_string(layered.capture_ready_acks)
        + " capture_failures=" + std::to_string(layered.capture_failures)
        + " live_reuse=" + std::to_string(layered.reused_live_frames)
        + " live_regions=" + std::to_string(layered.live_region_updates)
        + " live_region_bytes=" + std::to_string(layered.live_region_bytes)
        + " live_full_bytes=" + std::to_string(layered.live_full_bytes)
        + " incremental_frames=" + std::to_string(
            layered.incremental_frames)
        + " incremental_regions=" + std::to_string(
            layered.incremental_tiles)
        + " full_composes=" + std::to_string(layered.full_composes)
        + " fallback=" + std::to_string(layered.fallback_frames)
        + " cache_bytes=" + std::to_string(layered.cache_bytes)
        + " compose_us=" + std::to_string(layered.last_compose_ns / 1000)
        + " compose_p50_us=" + std::to_string(
            g_live_pipeline->ComposeLatencyPercentileUs(50))
        + " compose_p95_us=" + std::to_string(
            g_live_pipeline->ComposeLatencyPercentileUs(95))
        + " compose_p99_us=" + std::to_string(
            g_live_pipeline->ComposeLatencyPercentileUs(99))
        + " reason=" + (layered.last_fallback_reason.empty()
            ? "none" : layered.last_fallback_reason));
}

// Publish a composed frame into the FrameRing and bump paint_seq. Returns true
// when a frame was published.
bool TryPublishComposedFrame() {
    if (!g_live_pipeline || !g_live_pipeline->PrefersComposedOutput()) return false;
    if (cfg.decklink_direct_paint && consumer &&
        browser_ready.load(std::memory_order_acquire)) {
        if (compose_buf.empty()
            || !g_live_pipeline->ComposeIncrementalInto(
                compose_buf.data(), cfg.width, cfg.height)) {
            return false;
        }
        const uint64_t seq = paint_seq.fetch_add(1, std::memory_order_release) + 1;
        const bg::Frame frame{compose_buf.data(), cfg.width, cfg.height, seq};
        consumer->OnFrame(frame);
        return true;
    }
    if (!ring.UpdateLatest(cfg.width, cfg.height, [](uint8_t* destination) {
            return g_live_pipeline->ComposeIncrementalInto(
                destination, cfg.width, cfg.height);
        })) {
        return false;
    }
    paint_seq.fetch_add(1, std::memory_order_release);
    return true;
}

// Hold the last verified live bitmap when CEF misses a requested paint deadline.
// This preserves output cadence, but deliberately does not count as fresh CEF
// activity for the paint watchdog.
bool TryPublishReusableLiveFrameAfterMiss(uint64_t observed_seq) {
    if (!browser_ready.load(std::memory_order_acquire)
        || observed_seq != last_delivered_seq
        || !g_live_pipeline
        || !g_live_pipeline->HasReusableLiveFrame()
        || !TryPublishComposedFrame()) {
        return false;
    }
    g_live_pipeline->RecordReusedLiveFrame();
    return true;
}

void on_paint(const uint8_t* bgra, int width, int height) {
    // Doc02 PR5: when the live pipeline consumed a live-overlay paint, EngineClient
    // still forwards here with a null buffer as a "compose opportunity" signal.
    if (bgra == nullptr) {
        TryPublishComposedFrame();
        return;
    }
    const size_t bytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    if (cfg.decklink_direct_paint && consumer &&
        browser_ready.load(std::memory_order_acquire)) {
        // CEF owns `bgra` only for this callback. DecklinkConsumer::OnFrame
        // synchronously copies it into an owned AlignedBuffer before return,
        // so this bypasses the FrameRing copy without letting a CEF pointer
        // escape the OnPaint lifetime.
        const uint64_t seq = paint_seq.fetch_add(1, std::memory_order_release) + 1;
        const bg::Frame frame{bgra, width, height, seq};
        consumer->OnFrame(frame);
        consumer->RecordDirectDelivery(bytes);
        return;
    }

    const auto t_ring_copy = std::chrono::steady_clock::now();
    ring.Copy(bgra, width, height);
    if (consumer) {
        const auto us = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - t_ring_copy)
                .count());
        consumer->RecordRingCopy(us, bytes);
    }
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
    frame_log = std::make_unique<bg::FrameLog>(cfg.frame_log);
    if (frame_log->enabled()) {
        BG_LOG("frame-log enabled -> " + cfg.frame_log);
    }

    if (!bg::EngineInit(main_args, cfg.cache_dir, cfg.remote_debugging_port,
                        cfg.blink_research)) {
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

    // Doc02 PR3: attach a shadow RenderGraphStore so the page's BGGRAPH v1
    // snapshots are captured for offline diff debugging. Default-on: even when
    // the production compositor gate is off, the page may emit graph messages,
    // and we want the K2 review to have a baseline.
    bg::RenderGraphStore graph_store;
    client->set_graph_store(&graph_store);

    // Doc02 PR5: full-path layered compositor (default off). When enabled,
    // per-layer CEF snapshots feed the CPU mixer; unsupported graphs fall back
    // to the legacy monolith automatically.
    bg::compositor::LivePipeline live_pipeline;
    live_pipeline.Attach(&graph_store, cfg.width, cfg.height);
    auto layered_allowlist = LayeredTemplateAllowlist();
    const size_t layered_allowlist_size = layered_allowlist.size();
    live_pipeline.set_template_allowlist(std::move(layered_allowlist));
    live_pipeline.set_enabled(cfg.layered_compositor);
    if (cfg.layered_compositor) {
        if (cfg.decklink_direct_paint) {
            compose_buf.assign(
                static_cast<size_t>(cfg.width) * cfg.height * 4, 0);
        }
        g_live_pipeline = &live_pipeline;
        client->set_live_pipeline(&live_pipeline);
        // Graph publishing must be on so the store receives BGGRAPH snapshots.
        if (cfg.url.find("graph=1") == std::string::npos) {
            cfg.url += (cfg.url.find('?') == std::string::npos) ? "?graph=1" : "&graph=1";
            BG_LOG("layered compositor: appended graph=1 to url");
        }
        BG_LOG("layered compositor ENABLED (BG_LAYERED_COMPOSITOR=1)");
        BG_LOG(
            "layered compositor allowlist="
            + (layered_allowlist_size == 0
                ? std::string("unrestricted_research")
                : std::to_string(layered_allowlist_size)));
    }

    CefWindowInfo window_info;
    window_info.SetAsWindowless(0);  // OSR, no native window
    // External begin-frame: the engine pump is the compositor clock. Damage-
    // driven painting coalesces rAF-produced frames to ~25-30fps regardless of
    // windowless_frame_rate; with external begin frames every pump tick drives
    // exactly one compositor frame, so rAF/CSS/video all follow the channel
    // cadence (and later a hardware reference clock can drive this directly).
    window_info.external_begin_frame_enabled = 1;
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

    // Watchdog state: a single Invalidate if paints stall (see below). A
    // per-tick Invalidate flood is NOT allowed here — in CEF 149 OSR it maps
    // to the capturer's RequestRefreshFrame and floods it into delivering
    // blank buffers (black flicker on air, Phase 10.5 regression).
    auto last_any_paint = std::chrono::steady_clock::now();
    bg::PaintSequenceTracker cef_paint_tracker(client->cef_paint_seq());
    const auto observe_cef_paint_activity = [&] {
        if (cef_paint_tracker.Observe(client->cef_paint_seq())) {
            last_any_paint = std::chrono::steady_clock::now();
        }
    };

    // Phase 11.2: consumers with a hardware clock (DeckLink genlock +
    // scheduled playback) drive the pump directly instead of the engine
    // free-running its own 50Hz self-timer — see consumer.h and
    // docs/phase11-baseline.md §2-3 for why the self-timer/hardware-clock gap
    // was the dominant cause of multi-channel SDI judder. Every other
    // consumer (null/pipe/preview/stream — including Browser/OBS/vMix, which
    // always maps to the null consumer per run-channel.sh) has
    // HasExternalClock() == false and takes the ORIGINAL self-timer loop
    // below completely unchanged.
    const bool decklink_driven = consumer && consumer->HasExternalClock();

    if (decklink_driven) {
        MaybeSetRealtimePumpPriority();

        // Fallback timeout so a stalled/unplugged hardware clock can never
        // fully freeze rendering: if no tick request arrives within 2 output
        // frame periods, run one tick anyway (WaitForTick returns 0).
        const int64_t kFallbackTimeoutUs = 2 * static_cast<int64_t>(expected_us);

        while (true) {
            const int requested_ticks = consumer->WaitForTick(kFallbackTimeoutUs);
            const int run_ticks = requested_ticks > 0 ? requested_ticks : 1;

            for (int t = 0; t < run_ticks; ++t) {
                const auto tick_start = std::chrono::steady_clock::now();
                const auto tick_deadline = tick_start + std::chrono::microseconds(expected_us);

                if (browser_ready.load(std::memory_order_acquire)) {
                    if (g_live_pipeline) g_live_pipeline->OnTick();
                    // Cache-only compose: publish without waiting for CEF paint.
                    if (g_live_pipeline && g_live_pipeline->PrefersComposedOutput()
                        && !g_live_pipeline->NeedsLivePaint()) {
                        TryPublishComposedFrame();
                    }
                    if (CefRefPtr<CefBrowser> b = client->browser()) {
                        if (auto host = b->GetHost()) host->SendExternalBeginFrame();
                    }
                }

                // Phase 17 P0: pump_active_us accumulates the wall-clock time
                // spent inside CefDoMessageLoopWork() itself (not the sleeps
                // between slices) — the discriminator between a throughput-
                // bound raster pool (high pump_active/interval ratio) and a
                // latency-bound IPC round-trip (low ratio, most of the tick
                // spent sleeping/waiting on OnPaint). Zero-cost when
                // --frame-log is unset (two steady_clock::now() calls per
                // 4ms slice either way; only the CSV write is gated).
                uint64_t pump_active_us = 0;

                // Pump CEF in <=4ms slices for up to one full field period,
                // bailing out early once the paint we asked for lands.
                // IMPORTANT (P0.2 / Phase 18): CEF OSR coalesces dual in-flight
                // BeginFrames — never fire a second BF until paint_seq moves
                // (or this field's deadline expires). Each sub-tick still owns
                // up to ~20ms of wait budget; Phase 18 Fallback only removes
                // the *post*-paint sleep before the next sub-tick so two
                // sequential rasters can share one ~40ms output-frame window.
                while (true) {
                    const auto pump_t0 = std::chrono::steady_clock::now();
                    CefDoMessageLoopWork();
                    pump_active_us += std::chrono::duration_cast<std::chrono::microseconds>(
                        std::chrono::steady_clock::now() - pump_t0).count();
                    if (paint_seq.load(std::memory_order_acquire) != last_delivered_seq) break;
                    const auto now = std::chrono::steady_clock::now();
                    if (now >= tick_deadline) break;
                    const auto remaining = tick_deadline - now;
                    const auto slice = remaining < std::chrono::microseconds(4000)
                        ? remaining
                        : std::chrono::microseconds(4000);
                    std::this_thread::sleep_for(slice);
                }

                observe_cef_paint_activity();
                TryPublishReusableLiveFrameAfterMiss(
                    paint_seq.load(std::memory_order_acquire));
                const uint64_t cur_seq = paint_seq.load(std::memory_order_acquire);
                const bool got_new_paint = cur_seq != last_delivered_seq;
                auto delivery_time = std::chrono::steady_clock::now();
                uint64_t interval_us = 0;
                if (browser_ready.load(std::memory_order_acquire) && got_new_paint) {
                    last_delivered_seq = cur_seq;
                    if (!cfg.decklink_direct_paint) {
                        ring.Latest([&](const bg::Frame& f) {
                            if (consumer) consumer->OnFrame(f);
                        });
                    }

                    delivery_time = std::chrono::steady_clock::now();
                    if (have_last_paint) {
                        interval_us = std::chrono::duration_cast<std::chrono::microseconds>(
                            delivery_time - last_paint_time).count();
                    }
                    stats.RecordFrame(interval_us, expected_us);
                    last_paint_time = delivery_time;
                    have_last_paint = true;
                }

                if (frame_log && frame_log->enabled()) {
                    const uint64_t paint_latency_us = std::chrono::duration_cast<
                        std::chrono::microseconds>(delivery_time - tick_start).count();
                    const uint64_t wall_clock_us = std::chrono::duration_cast<
                        std::chrono::microseconds>(delivery_time.time_since_epoch()).count();
                    frame_log->RecordTick(wall_clock_us, interval_us, cur_seq, pump_active_us,
                                          paint_latency_us, got_new_paint ? 0 : 1);
                }

                if (browser_ready.load(std::memory_order_acquire)) {
                    const auto now = std::chrono::steady_clock::now();
                    if (now - last_any_paint > std::chrono::milliseconds(200)) {
                        last_any_paint = now;
                        if (CefRefPtr<CefBrowser> b = client->browser()) {
                            if (auto host = b->GetHost()) host->Invalidate(PET_VIEW);
                        }
                    }
                }

                // Phase 18 Fallback (see docs/development-phases/phase-18-true-50p-pipeline.md):
                // do NOT burn the remaining field budget after an early paint
                // before starting the next sub-tick's BeginFrame. P0.2 showed
                // CEF coalesces dual in-flight BeginFrames, so we still send
                // only one BF per sub-tick and wait for its paint_seq (or the
                // per-field deadline). But within one WaitForTick batch
                // (typically 2 fields / ~40ms for 1080i50) we start the next
                // BF immediately after delivery — giving the second raster the
                // leftover wall-clock of the output frame instead of sleeping
                // it away. That is sequential packing, not Approach A pipeline.
                //
                // Keep pumping CEF briefly so late IPC from the just-delivered
                // paint can settle, without waiting out tick_deadline.
                if (t + 1 < run_ticks) {
                    CefDoMessageLoopWork();
                }
            }

            const uint64_t elapsed_s = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::steady_clock::now() - start).count();
            if (cfg.stats_interval_sec > 0 &&
                elapsed_s >= last_stats_report + static_cast<uint64_t>(cfg.stats_interval_sec)) {
                last_stats_report = elapsed_s;
                BG_LOG(stats.Progress());
                LogLayeredStats();
            }

            if (cfg.duration_sec > 0 && elapsed_s >= static_cast<uint64_t>(cfg.duration_sec)) {
                BG_LOG("duration reached, shutting down");
                break;
            }

            if (consumer) {
                const int requested = consumer->PollExitCode();
                if (requested != 0) {
                    exit_code = requested;
                    BG_LOG("consumer requested exit code " + std::to_string(exit_code));
                    break;
                }
            }
        }
    } else {
    // Phase 18 P0.2: optional in-flight BeginFrame probe. When
    // BG_P18_PIPELINE_PROBE=1, the self-timer path fires TWO external
    // BeginFrames back-to-back at the start of each tick (without waiting
    // for the first OnPaint), then pumps CEF for one field period and
    // records how many unique paint_seq values arrived. Decision Gate uses
    // paint_seq_delta ≥ 2 as evidence that CEF OSR can pipeline composites.
    // Default (env unset) keeps the original single-BeginFrame path untouched.
    const bool pipeline_probe = [] {
        if (const char* v = std::getenv("BG_P18_PIPELINE_PROBE")) {
            return std::atoi(v) > 0;
        }
        return false;
    }();
    if (pipeline_probe) {
        BG_LOG("Phase 18 P0.2: BG_P18_PIPELINE_PROBE=1 — dual BeginFrame in-flight probe");
    }

    // Main loop: pump CEF, deliver latest frame to consumer, record cadence.
    while (true) {
        const auto tick_start = std::chrono::steady_clock::now();
        const uint64_t seq_at_tick_start = paint_seq.load(std::memory_order_acquire);
        int inflight_depth = 0;

        // Drive the compositor: one (or two, under pipeline probe) external
        // BeginFrame(s) per channel tick. rAF/CSS/video follow the channel
        // cadence under external begin-frame scheduling.
        if (browser_ready.load(std::memory_order_acquire)) {
            if (g_live_pipeline) g_live_pipeline->OnTick();
            if (CefRefPtr<CefBrowser> b = client->browser()) {
                if (auto host = b->GetHost()) {
                    host->SendExternalBeginFrame();
                    inflight_depth = 1;
                    if (pipeline_probe) {
                        // Second BeginFrame WITHOUT waiting for the first
                        // OnPaint — the whole point of the probe.
                        host->SendExternalBeginFrame();
                        inflight_depth = 2;
                    }
                }
            }
        }

        // Doc02 PR5: when composing from cache with no live layers, publish a
        // composed frame even without a CEF OnPaint this tick. Live overlays
        // publish via the OnPaint sentinel instead (avoids a double-publish
        // of a stale frame before the live paint lands).
        if (g_live_pipeline && g_live_pipeline->PrefersComposedOutput()
            && !g_live_pipeline->NeedsLivePaint()) {
            TryPublishComposedFrame();
        }

        // Phase 17 P0: see the decklink-driven branch above for rationale.
        // pump.Tick() itself calls CefDoMessageLoopWork() once; time it here
        // and accumulate the remaining_us slice loop below into the same
        // per-tick total.
        const auto pump_tick_t0 = std::chrono::steady_clock::now();
        const int64_t sleep_us = pump.Tick(/*out_painted=*/false);
        uint64_t pump_active_us = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - pump_tick_t0).count();
        observe_cef_paint_activity();

        // Deliver the latest painted frame to the consumer, but only when a new
        // OnPaint actually arrived (avoid double-counting / re-delivering).
        // Under pipeline_probe we may see paint_seq jump by >1; still deliver
        // only the latest (FrameRing is latest-only) — the probe cares about
        // the delta, not about delivering every intermediate bitmap.
        const uint64_t cur_seq = paint_seq.load(std::memory_order_acquire);
        const bool got_new_paint = cur_seq != last_delivered_seq;
        const int paint_seq_delta = static_cast<int>(
            cur_seq >= seq_at_tick_start ? cur_seq - seq_at_tick_start : 0);
        uint64_t interval_us = 0;
        auto delivery_time = std::chrono::steady_clock::now();
        if (browser_ready.load(std::memory_order_acquire) && got_new_paint) {
            last_delivered_seq = cur_seq;
            if (!cfg.decklink_direct_paint) {
                ring.Latest([&](const bg::Frame& f) {
                    if (consumer) consumer->OnFrame(f);
                });
            }

            // Record cadence against the previous paint time.
            delivery_time = std::chrono::steady_clock::now();
            if (have_last_paint) {
                interval_us = std::chrono::duration_cast<std::chrono::microseconds>(
                    delivery_time - last_paint_time).count();
            }
            stats.RecordFrame(interval_us, expected_us);
            last_paint_time = delivery_time;
            have_last_paint = true;
        }

        // Paint watchdog: the channel.html damage beacon keeps OnPaint alive at
        // the channel rate. If paints stop for >200ms (page crashed its rAF
        // loop, or truly static legacy page), nudge ONE refresh — never a
        // sustained Invalidate flood.
        if (browser_ready.load(std::memory_order_acquire)) {
            const auto now = std::chrono::steady_clock::now();
            if (now - last_any_paint > std::chrono::milliseconds(200)) {
                last_any_paint = now;
                if (CefRefPtr<CefBrowser> b = client->browser()) {
                    if (auto host = b->GetHost()) host->Invalidate(PET_VIEW);
                }
            }
        }

        // Periodic stats progress.
        const uint64_t elapsed_s = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - start).count();
        if (cfg.stats_interval_sec > 0 &&
            elapsed_s >= last_stats_report + static_cast<uint64_t>(cfg.stats_interval_sec)) {
            last_stats_report = elapsed_s;
            BG_LOG(stats.Progress());
            LogLayeredStats();
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

        // Sleep to the frame deadline in <=4ms slices, pumping CEF work in each
        // slice. A single 20ms sleep between pumps doubles renderer IPC
        // latency (CEF expects the external pump to run more often than the
        // frame rate) and starves video decode.
        int64_t remaining_us = sleep_us;
        while (remaining_us > 0) {
            const int64_t slice_us = remaining_us < 4000 ? remaining_us : 4000;
            std::this_thread::sleep_for(std::chrono::microseconds(slice_us));
            const auto slice_t0 = std::chrono::steady_clock::now();
            CefDoMessageLoopWork();
            pump_active_us += std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - slice_t0).count();
            remaining_us -= slice_us;
        }
        observe_cef_paint_activity();

        // Re-sample paint_seq after the sleep window so paint_seq_delta
        // includes paints that landed during the remaining_us slices (the
        // probe's whole point — did the second BeginFrame produce a second
        // OnPaint within one field period?). The default path still defers a
        // late fresh paint to the next tick, but publishes a verified hold-last
        // frame when no CEF paint arrived at all.
        uint64_t seq_after_sleep = paint_seq.load(std::memory_order_acquire);
        const int paint_seq_delta_final = static_cast<int>(
            seq_after_sleep >= seq_at_tick_start ? seq_after_sleep - seq_at_tick_start : 0);
        const bool reused_live_frame =
            !got_new_paint && !pipeline_probe
            && TryPublishReusableLiveFrameAfterMiss(seq_after_sleep);
        if (reused_live_frame) {
            seq_after_sleep = paint_seq.load(std::memory_order_acquire);
        }
        if ((pipeline_probe || reused_live_frame)
            && browser_ready.load(std::memory_order_acquire)
            && seq_after_sleep != last_delivered_seq) {
            last_delivered_seq = seq_after_sleep;
            if (!cfg.decklink_direct_paint) {
                ring.Latest([&](const bg::Frame& f) {
                    if (consumer) consumer->OnFrame(f);
                });
            }
            delivery_time = std::chrono::steady_clock::now();
            if (have_last_paint) {
                interval_us = std::chrono::duration_cast<std::chrono::microseconds>(
                    delivery_time - last_paint_time).count();
            }
            if (interval_us > 0) stats.RecordFrame(interval_us, expected_us);
            last_paint_time = delivery_time;
            have_last_paint = true;
        }

        if (frame_log && frame_log->enabled()) {
            const uint64_t paint_latency_us = std::chrono::duration_cast<
                std::chrono::microseconds>(delivery_time - tick_start).count();
            const uint64_t wall_clock_us = std::chrono::duration_cast<
                std::chrono::microseconds>(delivery_time.time_since_epoch()).count();
            const bool delivered = got_new_paint || reused_live_frame
                || (pipeline_probe && seq_after_sleep != seq_at_tick_start);
            frame_log->RecordTick(wall_clock_us, interval_us,
                                  (pipeline_probe || reused_live_frame)
                                      ? seq_after_sleep : cur_seq,
                                  pump_active_us, paint_latency_us,
                                  delivered ? 0 : 1,
                                  inflight_depth,
                                  pipeline_probe ? paint_seq_delta_final : paint_seq_delta);
        }
    }
    }  // decklink_driven / self-timer loop selection

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
