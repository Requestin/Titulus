// engine/src/mixer/mixer_buffer_pool.cpp

#include "mixer_buffer_pool.h"

#include <cstdlib>

namespace bg {

MixerBufferPool::~MixerBufferPool() { FreeAll(); }

MixerBuffer* MixerBufferPool::Acquire(size_t size) {
    if (size == 0) return nullptr;
    if (held_.size >= size && held_.data != nullptr) {
        return &held_;
    }
    if (held_.data) std::free(held_.data);
    const size_t rounded = (size + kAlign - 1) / kAlign * kAlign;
    held_.data = static_cast<uint8_t*>(std::aligned_alloc(kAlign, rounded));
    held_.size = held_.data ? rounded : 0;
    return held_.data ? &held_ : nullptr;
}

void MixerBufferPool::Release(MixerBuffer* /*buffer*/) {
    // The pool holds at most one buffer; nothing to do here.
}

void MixerBufferPool::FreeAll() {
    if (held_.data) std::free(held_.data);
    held_.data = nullptr;
    held_.size = 0;
}

}  // namespace bg
