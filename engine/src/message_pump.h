// engine/src/message_pump.h
//
// CEF message pump + frame deadline pacing for bg_engine.
//
// We drive CEF in "multi_threaded_message_loop = false" mode and pump it
// ourselves: each iteration pumps CEF work and, if enough wall-clock has elapsed
// since the previous BeginFrame, ticks the channel cadence. CEF's
// enable-begin-frame-scheduling (set in EngineApp) means the compositor paints
// when we give it work; the channel.html rAF heartbeat + windowless_frame_rate
// keep that at the configured fps.
//
// DEVELOPMENT_PROMPT §3.1 (CASPARRCG_PORTING.md): we follow the CasparCG
// consumer-driven pull pattern, not an explicit SendExternalBeginFrame push.
// The render host's job is just to pump CEF and report cadence via Stats.

#ifndef BG_ENGINE_MESSAGE_PUMP_H
#define BG_ENGINE_MESSAGE_PUMP_H

#include <chrono>
#include <cstdint>

namespace bg {

class MessagePump {
  public:
    using clock = std::chrono::steady_clock;

    explicit MessagePump(int fps) : target_interval_us_(1'000'000 / fps) {}

    // Call once per main-loop iteration. Pumps CEF work (non-blocking: at most
    // the work that's currently pending). Returns the number of microseconds to
    // sleep before the next iteration to hit the target fps cadence.
    // Also returns, via out_painted, whether a new paint was observed this tick
    // (used by the caller to record frame stats only on actual deliveries).
    int64_t Tick(bool /*out_painted*/) {
        // CefDoMessageLoopWork processes any pending CEF tasks (paint callbacks
        // included) and returns; it does not block. The FrameRing is updated by
        // the OnPaint callback synchronously inside this call.
        CefDoMessageLoopWork();

        const auto now = clock::now();
        const auto elapsed = std::chrono::duration_cast<
            std::chrono::microseconds>(now - last_).count();
        last_ = now;

        // Pace: sleep off the remainder of the target interval. Allow the loop
        // to catch up if we're already late (don't accumulate sleep debt).
        int64_t sleep_us = target_interval_us_ - elapsed;
        if (sleep_us < 0) sleep_us = 0;
        return sleep_us;
    }

    uint64_t target_interval_us() const { return target_interval_us_; }

  private:
    uint64_t target_interval_us_;
    clock::time_point last_ = clock::now();
};

}  // namespace bg

#endif  // BG_ENGINE_MESSAGE_PUMP_H
