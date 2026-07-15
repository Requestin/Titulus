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
    // Top-left source coordinate (in source pixels) for the destination pixel
    // (0, 0) of the layer's bounding box.
    float src_origin_x = 0.0f;
    float src_origin_y = 0.0f;
    // Forward affine coefficients mapping destination dx,dy -> source sx,sy.
    float a = 1.0f;  // dx coefficient on x
    float b = 0.0f;  // dy coefficient on x
    float c = 0.0f;  // dx coefficient on y
    float d = 1.0f;  // dy coefficient on y
    // Destination bounding box on the canvas.
    int32_t dest_x = 0;
    int32_t dest_y = 0;
    int32_t dest_w = 0;
    int32_t dest_h = 0;
    bool supported = true;
};

// Build the affine mapping for one layer layout. Returns `supported=false` for
// configurations the scalar mixer cannot represent exactly.
AffineMapping BuildAffineMapping(const LayerLayout& layout);

// Sample one BGRA8 pixel via nearest-neighbour. Returns false when the source
// coordinate falls outside the source buffer.
bool SampleNearest(const LayerBufferRef& src, float sx, float sy,
                   uint8_t out[4]);

}  // namespace bg

#endif  // BG_ENGINE_MIXER_AFFINE_SAMPLER_H
