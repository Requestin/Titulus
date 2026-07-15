// engine/src/compositor/layer_bitmap_cache.h
//
// Per-layer BGRA cache for the Doc02 full-path swap. Each cacheable source
// keeps its last CEF snapshot; live_html layers are overwritten every frame.
// The cache never owns the MixInput layer list — callers build MixInput from
// the current ProtocolSnapshot + these buffers.

#ifndef BG_ENGINE_COMPOSITOR_LAYER_BITMAP_CACHE_H
#define BG_ENGINE_COMPOSITOR_LAYER_BITMAP_CACHE_H

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

namespace bg::compositor {

struct LayerBitmap {
    std::vector<uint8_t> bgra;
    int32_t width = 0;
    int32_t height = 0;
    uint64_t capture_seq = 0;
};

class LayerBitmapCache {
  public:
    // Insert or replace a layer bitmap. `bgra` must be width*height*4 bytes.
    void Put(const std::string& layer_id, const uint8_t* bgra, int32_t width,
             int32_t height, uint64_t capture_seq);

    // Returns nullptr when the layer has never been captured.
    const LayerBitmap* Get(const std::string& layer_id) const;

    bool Has(const std::string& layer_id) const {
        return Get(layer_id) != nullptr;
    }

    void Clear() { entries_.clear(); }

    size_t size() const { return entries_.size(); }

  private:
    std::unordered_map<std::string, LayerBitmap> entries_;
};

}  // namespace bg::compositor

#endif  // BG_ENGINE_COMPOSITOR_LAYER_BITMAP_CACHE_H
