// engine/src/vs/producer.h — frame producers for bg_vs_engine (Unreal VS mode).
//
// Producers push latest BGRA into a shared buffer; the VS pipeline pulls on
// the output cadence. Reimplemented by reference from CasparCG producer
// semantics (latest-frame), not a GPL copy.

#ifndef BG_VS_PRODUCER_H
#define BG_VS_PRODUCER_H

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace bg {
namespace vs {

struct OwnedFrame {
    std::vector<uint8_t> bgra;
    int width = 0;
    int height = 0;
    uint64_t seq = 0;
};

class LatestFrameBuffer {
  public:
    void Publish(const uint8_t* bgra, int width, int height) {
        if (!bgra || width <= 0 || height <= 0) return;
        const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
        std::lock_guard<std::mutex> lock(mu_);
        buf_.bgra.assign(bgra, bgra + n);
        buf_.width = width;
        buf_.height = height;
        buf_.seq += 1;
    }

    // Copy latest into out. Returns false if never published.
    bool CopyLatest(OwnedFrame& out) const {
        std::lock_guard<std::mutex> lock(mu_);
        if (buf_.seq == 0 || buf_.bgra.empty()) return false;
        out = buf_;
        return true;
    }

    uint64_t Seq() const {
        std::lock_guard<std::mutex> lock(mu_);
        return buf_.seq;
    }

  private:
    mutable std::mutex mu_;
    OwnedFrame buf_;
};

class Producer {
  public:
    virtual ~Producer() = default;
    virtual bool Start(int width, int height, int fps) = 0;
    virtual void Stop() = 0;
    virtual const char* Label() const = 0;
    virtual LatestFrameBuffer& Buffer() = 0;
};

}  // namespace vs
}  // namespace bg

#endif  // BG_VS_PRODUCER_H
