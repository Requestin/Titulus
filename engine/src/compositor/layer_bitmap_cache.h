// engine/src/compositor/layer_bitmap_cache.h
//
// Per-layer BGRA cache for the Doc02 full-path swap. Each cacheable source
// keeps its last CEF snapshot; live_html layers are overwritten every frame.
// The cache never owns the MixInput layer list — callers build MixInput from
// the current ProtocolSnapshot + these buffers.

#ifndef BG_ENGINE_COMPOSITOR_LAYER_BITMAP_CACHE_H
#define BG_ENGINE_COMPOSITOR_LAYER_BITMAP_CACHE_H

#include <cstdint>
#include <span>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace bg::compositor {

struct LayerBitmap {
    std::vector<uint8_t> bgra;
    int32_t width = 0;
    int32_t height = 0;
    int32_t padding = 0;
    uint64_t capture_seq = 0;
};

struct LayerDirtyRect {
    int32_t x = 0;
    int32_t y = 0;
    int32_t width = 0;
    int32_t height = 0;
};

class LayerBitmapCache {
  public:
    static constexpr size_t kDefaultMaxBytes = 512ULL * 1024ULL * 1024ULL;

    explicit LayerBitmapCache(size_t max_bytes = kDefaultMaxBytes)
        : max_bytes_(max_bytes) {}

    // Insert or replace a layer bitmap. `bgra` must be width*height*4 bytes.
    bool Put(const std::string& layer_id, const uint8_t* bgra, int32_t width,
             int32_t height, uint64_t capture_seq);

    // Copy a tight top-left crop from a full CEF OSR canvas.
    bool PutCropped(const std::string& layer_id, const uint8_t* bgra,
                    int32_t canvas_width, int32_t canvas_height,
                    int32_t crop_width, int32_t crop_height, int32_t padding,
                    uint64_t capture_seq);

    // Update only CEF-reported dirty subregions of an existing tight crop.
    // Empty dirty_rects means a full-crop update.
    bool UpdateCropped(
        const std::string& layer_id, const uint8_t* bgra,
        int32_t canvas_width, int32_t canvas_height, int32_t crop_width,
        int32_t crop_height, int32_t padding,
        std::span<const LayerDirtyRect> dirty_rects, uint64_t capture_seq,
        size_t* copied_bytes = nullptr);

    // Clear a marker/control region after capture validation.
    bool ClearRect(const std::string& layer_id, int32_t x, int32_t y,
                   int32_t width, int32_t height);

    // Returns nullptr when the layer has never been captured.
    const LayerBitmap* Get(const std::string& layer_id) const;

    bool Has(const std::string& layer_id) const {
        return Get(layer_id) != nullptr;
    }

    void SetPinnedLayerIds(const std::vector<std::string>& layer_ids) {
        pinned_layer_ids_.clear();
        pinned_layer_ids_.insert(layer_ids.begin(), layer_ids.end());
    }

    void Clear() {
        entries_.clear();
        pinned_layer_ids_.clear();
        bytes_ = 0;
    }

    size_t size() const { return entries_.size(); }
    size_t bytes() const { return bytes_; }
    size_t max_bytes() const { return max_bytes_; }

  private:
    bool ReserveFor(const std::string& layer_id, size_t bytes);

    std::unordered_map<std::string, LayerBitmap> entries_;
    std::unordered_set<std::string> pinned_layer_ids_;
    size_t max_bytes_;
    size_t bytes_ = 0;
};

}  // namespace bg::compositor

#endif  // BG_ENGINE_COMPOSITOR_LAYER_BITMAP_CACHE_H
