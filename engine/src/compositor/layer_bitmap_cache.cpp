// engine/src/compositor/layer_bitmap_cache.cpp

#include "layer_bitmap_cache.h"

#include <cstring>

namespace bg::compositor {

void LayerBitmapCache::Put(const std::string& layer_id, const uint8_t* bgra,
                           int32_t width, int32_t height, uint64_t capture_seq) {
    if (!bgra || width <= 0 || height <= 0) return;
    const size_t bytes = static_cast<size_t>(width) * height * 4;
    LayerBitmap& entry = entries_[layer_id];
    entry.bgra.assign(bgra, bgra + bytes);
    entry.width = width;
    entry.height = height;
    entry.capture_seq = capture_seq;
}

const LayerBitmap* LayerBitmapCache::Get(const std::string& layer_id) const {
    const auto it = entries_.find(layer_id);
    if (it == entries_.end()) return nullptr;
    return &it->second;
}

}  // namespace bg::compositor
