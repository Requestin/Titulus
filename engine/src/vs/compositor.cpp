// engine/src/vs/compositor.cpp

#include "vs/compositor.h"

namespace bg {
namespace vs {

void CompositeOver(const uint8_t* bg, const uint8_t* fg, uint8_t* dst,
                   int width, int height) {
    if (!bg || !fg || !dst || width <= 0 || height <= 0) return;
    const size_t n = static_cast<size_t>(width) * static_cast<size_t>(height);
    for (size_t i = 0; i < n; ++i) {
        const uint8_t* f = fg + i * 4;
        const uint8_t* b = bg + i * 4;
        uint8_t* d = dst + i * 4;
        const int a = f[3];
        const int ia = 255 - a;
        d[0] = static_cast<uint8_t>((f[0] * a + b[0] * ia + 127) / 255);
        d[1] = static_cast<uint8_t>((f[1] * a + b[1] * ia + 127) / 255);
        d[2] = static_cast<uint8_t>((f[2] * a + b[2] * ia + 127) / 255);
        d[3] = 255;
    }
}

}  // namespace vs
}  // namespace bg
