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
    //
    // Pacing uses an absolute deadline schedule. The previous version measured
    // "elapsed since last Tick" (which included the sleep itself) and
    // subtracted it from the target — that oscillates between sleep=0 and
    // sleep=target and runs the loop at ~2x the channel rate.
    int64_t Tick(bool /*out_painted*/) {
        // CefDoMessageLoopWork processes any pending CEF tasks (paint callbacks
        // included) and returns; it does not block. The FrameRing is updated by
        // the OnPaint callback synchronously inside this call.
        CefDoMessageLoopWork();

        const auto now = clock::now();
        if (next_deadline_.time_since_epoch().count() == 0) {
            next_deadline_ = now + std::chrono::microseconds(target_interval_us_);
            return static_cast<int64_t>(target_interval_us_);
        }

        next_deadline_ += std::chrono::microseconds(target_interval_us_);
        if (next_deadline_ <= now) {
            // Running late: re-anchor to now instead of accumulating debt
            // (a burst of zero-sleep iterations would overshoot the cadence).
            next_deadline_ = now + std::chrono::microseconds(target_interval_us_);
            return 0;
        }
        return std::chrono::duration_cast<std::chrono::microseconds>(
            next_deadline_ - now).count();
    }

    uint64_t target_interval_us() const { return target_interval_us_; }

  private:
    uint64_t target_interval_us_;
    clock::time_point next_deadline_{};
};

}  // namespace bg

#endif  // BG_ENGINE_MESSAGE_PUMP_H
