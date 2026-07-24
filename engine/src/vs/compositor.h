// engine/src/vs/compositor.h — BG + keyed FG over (BGRA).

#ifndef BG_VS_COMPOSITOR_H
#define BG_VS_COMPOSITOR_H

#include <cstdint>
#include <vector>

namespace bg {
namespace vs {

// dst = over(fg_premul_or_straight, bg). FG alpha in FG[3] (straight).
// Sizes must match. dst may alias neither, or equal to bg.
void CompositeOver(const uint8_t* bg, const uint8_t* fg, uint8_t* dst,
                   int width, int height);

}  // namespace vs
}  // namespace bg

#endif
