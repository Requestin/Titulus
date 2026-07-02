// engine/src/aligned_buffer.h
//
// Phase 11.3: a fixed-size, 64-byte-aligned, move-only heap buffer for the
// DeckLink hot path. Cache-line alignment matters for two reasons here:
//   - non-temporal (streaming) SIMD stores need aligned addresses to hit the
//     fast path (see simd_copy.h);
//   - avoids a buffer's first bytes sharing a cache line with unrelated heap
//     metadata, which matters when the same buffer is written by one thread
//     (render) and read by another (DeckLink completion callback).
//
// Deliberately narrow: fixed-size allocate/reset, raw pointer access, no
// growth. This is not a general-purpose container.

#ifndef BG_ENGINE_ALIGNED_BUFFER_H
#define BG_ENGINE_ALIGNED_BUFFER_H

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <utility>

namespace bg {

class AlignedBuffer {
  public:
    static constexpr size_t kAlign = 64;

    AlignedBuffer() = default;
    explicit AlignedBuffer(size_t size) { Reset(size); }
    AlignedBuffer(const AlignedBuffer&) = delete;
    AlignedBuffer& operator=(const AlignedBuffer&) = delete;

    AlignedBuffer(AlignedBuffer&& other) noexcept { *this = std::move(other); }
    AlignedBuffer& operator=(AlignedBuffer&& other) noexcept {
        if (this != &other) {
            Free();
            data_ = other.data_;
            size_ = other.size_;
            other.data_ = nullptr;
            other.size_ = 0;
        }
        return *this;
    }

    ~AlignedBuffer() { Free(); }

    // Allocates `size` usable bytes (rounded up to kAlign internally). No-op
    // if the buffer is already exactly this size (reuse without a syscall —
    // this is the pooling fast path).
    void Reset(size_t size) {
        if (size == size_ && (data_ || size == 0)) return;
        Free();
        if (size == 0) return;
        const size_t rounded = (size + kAlign - 1) / kAlign * kAlign;
        data_ = static_cast<uint8_t*>(std::aligned_alloc(kAlign, rounded));
        size_ = size;
    }

    uint8_t* data() { return data_; }
    const uint8_t* data() const { return data_; }
    size_t size() const { return size_; }
    bool empty() const { return size_ == 0; }

    void ZeroFill() {
        if (data_) std::memset(data_, 0, size_);
    }

    void CopyFrom(const uint8_t* src, size_t bytes) {
        if (data_ && bytes <= size_) std::memcpy(data_, src, bytes);
    }

  private:
    void Free() {
        if (data_) std::free(data_);
        data_ = nullptr;
        size_ = 0;
    }

    uint8_t* data_ = nullptr;
    size_t size_ = 0;
};

}  // namespace bg

#endif  // BG_ENGINE_ALIGNED_BUFFER_H
