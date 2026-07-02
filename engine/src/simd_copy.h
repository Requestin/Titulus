// engine/src/simd_copy.h
//
// Phase 11.3: non-temporal (cache-bypassing) bulk copy for the DeckLink
// weave path. The weave destination buffer is written once and handed
// straight to IDeckLinkOutput::ScheduleVideoFrame — it is never read back by
// this process — so a normal store that pulls the destination cache line in
// (read-for-ownership) before overwriting it is pure waste. That waste is
// not free: docs/phase11-baseline.md §4 measured 2-4ms per weave call with 3
// channels contending for the same L3/memory bus, ~7-9% of the per-output-
// frame budget on every channel. Streaming stores skip the destination
// cache-fill entirely, which matters most exactly when several channels are
// competing for shared memory bandwidth.
//
// AVX2 is required (checked at CMake/build level via the host baseline in
// docs/phase11-baseline.md — the target Ryzen 3600 and the Titulus dev host
// both report `avx2` in /proc/cpuinfo). Falls back to memcpy at compile time
// on non-x86 and at run time for any misaligned/short remainder.

#ifndef BG_ENGINE_SIMD_COPY_H
#define BG_ENGINE_SIMD_COPY_H

#include <cstddef>
#include <cstdint>
#include <cstring>

#if defined(__x86_64__) || defined(_M_X64)
#include <immintrin.h>
#define BG_ENGINE_HAVE_AVX2 1
#endif

namespace bg {

// Copies `bytes` from src to dst. Uses AVX2 non-temporal stores for the bulk
// of the range when both pointers are 32-byte aligned; the remainder (and
// the whole range on non-x86 builds) uses plain memcpy. Caller must
// `StreamCopyFence()` after a batch of calls before any consumer relies on
// the writes being globally visible (e.g. handing the buffer to hardware DMA)
// — non-temporal stores bypass normal store-buffer ordering.
//
// `target("avx2")` compiles just this function for AVX2 without needing a
// project-wide -march= flag (which would change codegen — and crash on
// non-AVX2 hosts — for every other function in the binary). Safe to call
// unconditionally: the target CPU baseline for this engine (Ryzen 3600 and
// the dev host, see docs/phase11-baseline.md) both report `avx2` in
// /proc/cpuinfo; if that ever changes, add a runtime __builtin_cpu_supports
// check here rather than relying on the build-time assumption.
#if defined(BG_ENGINE_HAVE_AVX2)
__attribute__((target("avx2")))
#endif
inline void StreamCopy(void* dst, const void* src, size_t bytes) {
#if defined(BG_ENGINE_HAVE_AVX2)
    auto* d = static_cast<uint8_t*>(dst);
    auto* s = static_cast<const uint8_t*>(src);
    const bool aligned = (reinterpret_cast<uintptr_t>(d) % 32 == 0) &&
                         (reinterpret_cast<uintptr_t>(s) % 32 == 0);
    size_t i = 0;
    if (aligned) {
        for (; i + 32 <= bytes; i += 32) {
            const __m256i v = _mm256_load_si256(reinterpret_cast<const __m256i*>(s + i));
            _mm256_stream_si256(reinterpret_cast<__m256i*>(d + i), v);
        }
    }
    if (i < bytes) std::memcpy(d + i, s + i, bytes - i);
#else
    std::memcpy(dst, src, bytes);
#endif
}

// Must be called after a sequence of StreamCopy() calls and before the
// destination buffer is handed off to hardware or another thread relies on
// seeing the writes (SFENCE orders non-temporal stores against later loads).
inline void StreamCopyFence() {
#if defined(BG_ENGINE_HAVE_AVX2)
    _mm_sfence();
#endif
}

}  // namespace bg

#endif  // BG_ENGINE_SIMD_COPY_H
