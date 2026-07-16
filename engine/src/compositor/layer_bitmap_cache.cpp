// engine/src/compositor/layer_bitmap_cache.cpp

#include "layer_bitmap_cache.h"

#include <algorithm>
#include <cstring>
#include <limits>

namespace bg::compositor {

bool LayerBitmapCache::ReserveFor(const std::string& layer_id, size_t bytes) {
    const auto existing = entries_.find(layer_id);
    if (bytes > max_bytes_) return false;
    const size_t existing_bytes =
        existing == entries_.end() ? 0 : existing->second.bgra.size();
    const size_t retained_bytes = bytes_ - existing_bytes;
    if (retained_bytes <= max_bytes_ - bytes) {
        if (existing != entries_.end()) {
            bytes_ -= existing_bytes;
            entries_.erase(existing);
        }
        return true;
    }

    std::vector<std::string> victims;
    victims.reserve(entries_.size());
    for (const auto& [id, entry] : entries_) {
        if (id != layer_id && !pinned_layer_ids_.contains(id)) {
            victims.push_back(id);
        }
    }
    std::sort(
        victims.begin(), victims.end(),
        [this](const std::string& a, const std::string& b) {
            const auto& left = entries_.at(a);
            const auto& right = entries_.at(b);
            if (left.capture_seq != right.capture_seq) {
                return left.capture_seq < right.capture_seq;
            }
            return a < b;
        });
    size_t reclaimable = 0;
    size_t victim_count = 0;
    while (retained_bytes - reclaimable > max_bytes_ - bytes
           && victim_count < victims.size()) {
        reclaimable += entries_.at(victims[victim_count]).bgra.size();
        ++victim_count;
    }
    if (retained_bytes - reclaimable > max_bytes_ - bytes) return false;

    if (existing != entries_.end()) {
        bytes_ -= existing_bytes;
        entries_.erase(existing);
    }
    for (size_t i = 0; i < victim_count; ++i) {
        const auto victim = entries_.find(victims[i]);
        if (victim == entries_.end()) continue;
        bytes_ -= victim->second.bgra.size();
        entries_.erase(victim);
    }
    return true;
}

bool LayerBitmapCache::Put(const std::string& layer_id, const uint8_t* bgra,
                           int32_t width, int32_t height,
                           uint64_t capture_seq) {
    if (!bgra || width <= 0 || height <= 0) return false;
    const size_t bytes = static_cast<size_t>(width) * height * 4;
    if (!ReserveFor(layer_id, bytes)) return false;
    LayerBitmap& entry = entries_[layer_id];
    entry.bgra.assign(bgra, bgra + bytes);
    entry.width = width;
    entry.height = height;
    entry.padding = 0;
    entry.capture_seq = capture_seq;
    bytes_ += bytes;
    return true;
}

bool LayerBitmapCache::PutCropped(
    const std::string& layer_id, const uint8_t* bgra, int32_t canvas_width,
    int32_t canvas_height, int32_t crop_width, int32_t crop_height,
    int32_t padding, uint64_t capture_seq) {
    if (!bgra || canvas_width <= 0 || canvas_height <= 0 || crop_width <= 0
        || crop_height <= 0 || crop_width > canvas_width
        || crop_height > canvas_height || padding < 0) {
        return false;
    }
    const size_t row_bytes = static_cast<size_t>(crop_width) * 4;
    if (row_bytes > std::numeric_limits<size_t>::max()
            / static_cast<size_t>(crop_height)) {
        return false;
    }
    const size_t bytes = row_bytes * static_cast<size_t>(crop_height);
    if (!ReserveFor(layer_id, bytes)) return false;
    LayerBitmap entry;
    entry.bgra.resize(bytes);
    const size_t source_stride = static_cast<size_t>(canvas_width) * 4;
    for (int32_t y = 0; y < crop_height; ++y) {
        std::memcpy(entry.bgra.data() + static_cast<size_t>(y) * row_bytes,
                    bgra + static_cast<size_t>(y) * source_stride, row_bytes);
    }
    entry.width = crop_width;
    entry.height = crop_height;
    entry.padding = padding;
    entry.capture_seq = capture_seq;
    bytes_ += bytes;
    entries_.emplace(layer_id, std::move(entry));
    return true;
}

bool LayerBitmapCache::UpdateCropped(
    const std::string& layer_id, const uint8_t* bgra,
    int32_t canvas_width, int32_t canvas_height, int32_t crop_width,
    int32_t crop_height, int32_t padding,
    std::span<const LayerDirtyRect> dirty_rects, uint64_t capture_seq,
    size_t* copied_bytes) {
    if (copied_bytes) *copied_bytes = 0;
    if (!bgra || canvas_width <= 0 || canvas_height <= 0 || crop_width <= 0
        || crop_height <= 0 || crop_width > canvas_width
        || crop_height > canvas_height || padding < 0) {
        return false;
    }
    const auto it = entries_.find(layer_id);
    if (it == entries_.end()) return false;
    LayerBitmap& entry = it->second;
    if (entry.width != crop_width || entry.height != crop_height
        || entry.padding != padding) {
        return false;
    }

    const size_t source_stride = static_cast<size_t>(canvas_width) * 4;
    const size_t destination_stride = static_cast<size_t>(crop_width) * 4;
    size_t copied = 0;
    const auto copy_rect = [&](int64_t left, int64_t top,
                               int64_t right, int64_t bottom) {
        left = std::clamp<int64_t>(left, 0, crop_width);
        top = std::clamp<int64_t>(top, 0, crop_height);
        right = std::clamp<int64_t>(right, 0, crop_width);
        bottom = std::clamp<int64_t>(bottom, 0, crop_height);
        if (left >= right || top >= bottom) return;
        const size_t row_bytes = static_cast<size_t>(right - left) * 4;
        for (int64_t y = top; y < bottom; ++y) {
            std::memcpy(
                entry.bgra.data() + static_cast<size_t>(y)
                    * destination_stride + static_cast<size_t>(left) * 4,
                bgra + static_cast<size_t>(y) * source_stride
                    + static_cast<size_t>(left) * 4,
                row_bytes);
        }
        copied += row_bytes * static_cast<size_t>(bottom - top);
    };

    if (dirty_rects.empty()) {
        copy_rect(0, 0, crop_width, crop_height);
    } else {
        for (const auto& rect : dirty_rects) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            copy_rect(
                rect.x, rect.y,
                static_cast<int64_t>(rect.x) + rect.width,
                static_cast<int64_t>(rect.y) + rect.height);
        }
    }
    entry.capture_seq = capture_seq;
    if (copied_bytes) *copied_bytes = copied;
    return true;
}

bool LayerBitmapCache::ClearRect(const std::string& layer_id, int32_t x,
                                 int32_t y, int32_t width, int32_t height) {
    const auto it = entries_.find(layer_id);
    if (it == entries_.end() || x < 0 || y < 0 || width <= 0 || height <= 0) {
        return false;
    }
    LayerBitmap& entry = it->second;
    const int64_t right = static_cast<int64_t>(x) + width;
    const int64_t bottom = static_cast<int64_t>(y) + height;
    if (right > entry.width || bottom > entry.height) return false;
    const size_t row_bytes = static_cast<size_t>(width) * 4;
    for (int32_t row = y; row < y + height; ++row) {
        std::memset(
            entry.bgra.data()
                + (static_cast<size_t>(row) * entry.width + x) * 4,
            0, row_bytes);
    }
    return true;
}

const LayerBitmap* LayerBitmapCache::Get(const std::string& layer_id) const {
    const auto it = entries_.find(layer_id);
    if (it == entries_.end()) return nullptr;
    return &it->second;
}

}  // namespace bg::compositor
