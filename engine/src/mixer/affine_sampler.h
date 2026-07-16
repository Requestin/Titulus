// engine/src/mixer/affine_sampler.h
//
// Affine sampler over a BGRA8 source. Scalar reference path: nearest-neighbour
// for scale, anchor-aware rotation. The mixer uses this to walk destination
// pixels and fetch source pixels.

#ifndef BG_ENGINE_MIXER_AFFINE_SAMPLER_H
#define BG_ENGINE_MIXER_AFFINE_SAMPLER_H

#include "render_graph_types.h"

#include <cstdint>

namespace bg {

struct AffineMapping {
    // Inverse affine coefficients mapping canvas pixel centers to source pixel
    // centers. Sample source coordinates as:
    //   sx = inv00*(x+.5) + inv01*(y+.5) + inv02
    //   sy = inv10*(x+.5) + inv11*(y+.5) + inv12
    float inv00 = 1.0f;
    float inv01 = 0.0f;
    float inv02 = 0.0f;
    float inv10 = 0.0f;
    float inv11 = 1.0f;
    float inv12 = 0.0f;
    // Destination bounding box on the canvas.
    int32_t dest_x = 0;
    int32_t dest_y = 0;
    int32_t dest_w = 0;
    int32_t dest_h = 0;
    bool supported = true;
};

// Build the affine mapping for one layer layout. Arbitrary finite 2D rotations
// are supported. Returns `supported=false` for singular/non-finite transforms.
AffineMapping BuildAffineMapping(const LayerLayout& layout);

// Sample one BGRA8 pixel via nearest-neighbour. Returns false when the source
// coordinate falls outside the source buffer.
bool SampleNearest(const LayerBufferRef& src, float sx, float sy,
                   uint8_t out[4]);

}  // namespace bg

#endif  // BG_ENGINE_MIXER_AFFINE_SAMPLER_H
