#ifndef BG_ENGINE_CEF_PAINT_WAIT_H
#define BG_ENGINE_CEF_PAINT_WAIT_H

#include <cstdint>

namespace bg {

enum class CefPaintWaitDecision : uint8_t {
    Continue,
    PaintObserved,
    Timeout,
    NoRequest,
};

struct CefPaintWaitSample {
    bool request_sent = false;
    uint64_t cef_seq_at_send = 0;
    uint64_t cef_seq_now = 0;
    bool deadline_reached = false;
};

[[nodiscard]] constexpr CefPaintWaitDecision DecideCefPaintWait(
    const CefPaintWaitSample& sample) noexcept {
    if (!sample.request_sent) return CefPaintWaitDecision::NoRequest;
    if (sample.cef_seq_now > sample.cef_seq_at_send) {
        return CefPaintWaitDecision::PaintObserved;
    }
    if (sample.deadline_reached) return CefPaintWaitDecision::Timeout;
    return CefPaintWaitDecision::Continue;
}

}  // namespace bg

#endif  // BG_ENGINE_CEF_PAINT_WAIT_H
