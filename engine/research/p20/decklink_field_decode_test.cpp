#include "decklink_field_decode.h"

#include <cstdint>
#include <span>
#include <vector>

namespace {

using titulus::p20::capture::DecodeP20GreenBar;
using titulus::p20::capture::FieldOrder;
using titulus::p20::capture::FieldParities;
using titulus::p20::capture::FieldParity;
using titulus::p20::capture::HashFieldFNV1a64;
using titulus::p20::capture::kBarBottom;
using titulus::p20::capture::kBarTop;
using titulus::p20::capture::kBarX;
using titulus::p20::capture::kBarStep;
using titulus::p20::capture::kHeight;
using titulus::p20::capture::kWidth;

constexpr int kRowBytes = kWidth * 2;

void PaintGreenBar(std::vector<uint8_t>& container, FieldParity parity, int residue) {
    const int left = kBarX + residue * kBarStep;
    for (int y = kBarTop + static_cast<int>(parity); y < kBarBottom; y += 2) {
        auto* row = container.data() + static_cast<size_t>(y) * kRowBytes;
        for (int x = left; x < left + 18; x += 2) {
            const size_t offset = static_cast<size_t>(x) * 2;
            row[offset] = 100;      // U
            row[offset + 1] = 180;  // Y0
            row[offset + 2] = 80;   // V
            row[offset + 3] = 180;  // Y1
        }
    }
}

}  // namespace

int main() {
    std::vector<uint8_t> container(static_cast<size_t>(kRowBytes) * kHeight, 16);
    PaintGreenBar(container, FieldParity::Even, 7);
    PaintGreenBar(container, FieldParity::Odd, 42);

    const auto even = DecodeP20GreenBar(container, kRowBytes, FieldParity::Even);
    const auto odd = DecodeP20GreenBar(container, kRowBytes, FieldParity::Odd);
    if (!even.residue.has_value() || *even.residue != 7 ||
        !odd.residue.has_value() || *odd.residue != 42 ||
        even.matching_scanlines <= 300 || odd.matching_scanlines <= 300) {
        return 1;
    }

    const auto tff = FieldParities(FieldOrder::TopFieldFirst);
    const auto bff = FieldParities(FieldOrder::BottomFieldFirst);
    if (tff[0] != FieldParity::Even || tff[1] != FieldParity::Odd ||
        bff[0] != FieldParity::Odd || bff[1] != FieldParity::Even) {
        return 1;
    }

    const std::string even_hash = HashFieldFNV1a64(container, kRowBytes, FieldParity::Even);
    const std::string odd_hash = HashFieldFNV1a64(container, kRowBytes, FieldParity::Odd);
    if (even_hash.size() != 16 || odd_hash.size() != 16 || even_hash == odd_hash) return 1;

    std::vector<uint8_t> blank(static_cast<size_t>(kRowBytes) * kHeight, 16);
    return DecodeP20GreenBar(blank, kRowBytes, FieldParity::Even).residue.has_value() ? 1 : 0;
}
