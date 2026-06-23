// engine/src/frame_ring.h
//
// Single-producer / single-consumer latest-frame holder.
//
// Producer = CEF OnPaint callback (runs on the CEF UI thread).
// Consumer = consumer thread (or the main pump for null/pipe/preview).
//
// We only ever need the LATEST frame: rendering is paced by BeginFrame and the
// consumer pulls at its own cadence; an older frame is stale. So this is a
// one-slot "latest" with a sequence counter, not a FIFO. This matches the
// frame_ring pattern used by CasparCG-equivalent render hosts.

#ifndef BG_ENGINE_FRAME_RING_H
#define BG_ENGINE_FRAME_RING_H

#include "consumers/consumer.h"

#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <vector>

namespace bg {

class FrameRing {
  public:
    // Reallocate the backing BGRA buffer for the given geometry. Called when the
    // first frame establishes the size (or on resize). bgra buffer is owned here
    // so consumers see a stable pointer after Copy().
    void Resize(int width, int height) {
        std::lock_guard<std::mutex> lock(mu_);
        const size_t bytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
        if (buffer_.size() != bytes) buffer_.assign(bytes, 0);
        width_  = width;
        height_ = height;
    }

    // Producer side: copy the incoming BGRA bytes from a CEF OnPaint buffer and
    // publish under the sequence counter. (CEF's buffer is only valid for the
    // duration of the OnPaint call, hence the copy.)
    void Copy(const uint8_t* bgra, int width, int height) {
        if (width != width_ || height != height_) Resize(width, height);
        {
            std::lock_guard<std::mutex> lock(mu_);
            const size_t bytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
            std::memcpy(buffer_.data(), bgra, bytes);
        }
        // Acquire/release fence via the atomic sequence bump; consumers compare
        // the sequence before/after reading to detect a torn read.
        seq_.store(++latest_seq_, std::memory_order_release);
    }

    // Consumer side: deliver the latest frame to the visitor. Returns the frame
    // sequence observed (so callers can dedup). The Frame.bgra pointer is valid
    // only for the duration of the visitor call.
    template <typename Visit>
    uint64_t Latest(Visit&& visit) {
        const uint64_t before = seq_.load(std::memory_order_acquire);
        std::lock_guard<std::mutex> lock(mu_);
        const uint64_t after = seq_.load(std::memory_order_acquire);
        // If the producer wrote during our read, the data is torn for this
        // snapshot — but for "latest frame" delivery that's acceptable (the
        // next pump tick gets a clean copy). We still deliver the bytes we have.
        Frame f;
        f.bgra   = buffer_.data();
        f.width  = width_;
        f.height = height_;
        f.seq    = before;
        visit(f);
        return after;
    }

    int width()  const { return width_; }
    int height() const { return height_; }

  private:
    std::mutex          mu_;
    std::vector<uint8_t> buffer_;
    int                 width_  = 0;
    int                 height_ = 0;
    uint64_t            latest_seq_ = 0;
    std::atomic<uint64_t> seq_{0};
};

}  // namespace bg

#endif  // BG_ENGINE_FRAME_RING_H
