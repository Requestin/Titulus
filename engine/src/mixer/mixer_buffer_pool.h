// engine/src/mixer/mixer_buffer_pool.h
//
// 64-byte aligned reusable buffer pool. The mixer needs a scratch buffer per
// active destination row when partial writes are required; the pool avoids
// per-frame allocation churn.

#ifndef BG_ENGINE_MIXER_MIXER_BUFFER_POOL_H
#define BG_ENGINE_MIXER_MIXER_BUFFER_POOL_H

#include <cstddef>
#include <cstdint>

namespace bg {

struct MixerBuffer {
    uint8_t* data = nullptr;
    size_t size = 0;
};

// Tiny free-list pool. Not thread-safe; the mixer is consumed on the pump
// thread only. Sufficient for the scalar POC: AVX2 + parallelism in PR7 adds
// per-worker pools.
class MixerBufferPool {
  public:
    MixerBufferPool() = default;
    ~MixerBufferPool();

    MixerBufferPool(const MixerBufferPool&) = delete;
    MixerBufferPool& operator=(const MixerBufferPool&) = delete;

    // Returns a buffer of at least `size` usable bytes. The previous buffer of
    // the same size is reused if available.
    MixerBuffer* Acquire(size_t size);

    // Return a buffer to the pool. The pointer remains owned by the pool.
    void Release(MixerBuffer* buffer);

  private:
    void FreeAll();

    MixerBuffer held_;
    // Alignment matches AlignedBuffer (64 bytes) so AVX2 loads land cleanly
    // when the SIMD PR lands.
    static constexpr size_t kAlign = 64;
};

}  // namespace bg

#endif  // BG_ENGINE_MIXER_MIXER_BUFFER_POOL_H
