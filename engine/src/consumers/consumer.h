// engine/src/consumers/consumer.h
//
// Abstract consumer interface for bg_engine (DEVELOPMENT_PROMPT §9.6).
//
// The frame pipeline is CasparCG-aligned (CASPARRCG_PORTING.md §2):
//   CEF OSR OnPaint -> BGRA frame_ring -> Consumer::OnFrame()
//
// A consumer owns no rendering; it receives ready BGRA frames and disposes of
// them (write to SDI / file / pipe / JPEG / network, or discard for bench).
// Pacing is consumer-driven: the DeckLink consumer schedules output against the
// hardware reference clock and pulls frames on its own cadence; null/pipe/preview
// just consume each OnPaint call.
//
// Reimplemented by reference from CasparCG core/consumer + modules/{decklink,ffmpeg}
// patterns. No CasparCG code is linked or shipped.

#ifndef BG_ENGINE_CONSUMERS_CONSUMER_H
#define BG_ENGINE_CONSUMERS_CONSUMER_H

#include <cstddef>
#include <cstdint>

namespace bg {

// A single BGRA frame delivered by the CEF OSR paint callback.
// BGRA is the canonical pixel format end-to-end (no BGRA->ARGB conversion;
// CASPARRCG_PORTING.md §3.4). stride == width*4, no padding.
struct Frame {
    const uint8_t* bgra = nullptr;  // not owned; valid only for the OnFrame call
    int            width  = 0;
    int            height = 0;
    uint64_t       seq    = 0;      // monotonic frame sequence since engine start
};

// Abstract output sink. Lifetime: Start() once at channel up, OnFrame() per
// paint, Stop() on channel down. Implementations must be safe to call OnFrame()
// from the CEF UI thread (the paint thread).
class Consumer {
  public:
    virtual ~Consumer() = default;

    // Called once before the first frame. width/height/fps describe the channel
    // format (e.g. 1920x1080@50). Return false to abort channel startup.
    virtual bool Start(int width, int height, int fps) = 0;

    // Called for every OSR OnPaint of type PET_VIEW. The Frame buffer is owned
    // by the engine and is invalidated after the call returns; consumers that
    // need async ownership must copy the bytes.
    virtual void OnFrame(const Frame& frame) = 0;

    // Called once after the last frame. Safe to call even if Start() failed.
    virtual void Stop() = 0;

    // Human-readable label for logs (e.g. "decklink[0]", "pipe", "null").
    virtual const char* Label() const = 0;

    // Optional non-zero process exit code requested by the consumer.
    // DeckLink uses this to ask the supervisor for a controlled restart
    // (e.g. profile switch -> exit 42). Most consumers always return 0.
    virtual int PollExitCode() const { return 0; }
};

}  // namespace bg

#endif  // BG_ENGINE_CONSUMERS_CONSUMER_H
