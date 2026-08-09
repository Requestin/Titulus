#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <iomanip>
#include <optional>
#include <sstream>
#include <span>
#include <string>

namespace titulus::p20::capture {

constexpr int kWidth = 1920;
constexpr int kHeight = 1080;
constexpr int kBarX = 144;
constexpr int kBarStep = 24;
constexpr int kResidueCount = 64;
constexpr int kBarTop = 180;
constexpr int kBarBottom = 900;
constexpr int kMinimumGreenScanlines = 250;

enum class FieldParity : uint8_t {
    Even = 0,
    Odd = 1,
};

enum class FieldOrder : uint8_t {
    TopFieldFirst,
    BottomFieldFirst,
};

struct DecodedField {
    std::optional<uint8_t> residue;
    int matching_scanlines = 0;
};

constexpr const char* FieldParityName(FieldParity parity) noexcept {
    return parity == FieldParity::Even ? "even" : "odd";
}

constexpr std::array<FieldParity, 2> FieldParities(FieldOrder order) noexcept {
    if (order == FieldOrder::TopFieldFirst) {
        return {FieldParity::Even, FieldParity::Odd};
    }
    return {FieldParity::Odd, FieldParity::Even};
}

inline bool IsP20Green(uint8_t u, uint8_t y0, uint8_t v, uint8_t y1) noexcept {
    // Rec.709 conversion of opaque #00ff7f remains high luma with low V in
    // 8-bit UYVY. The ranges leave margin for normal SDI transport variation.
    return u >= 75 && u <= 150 && v <= 110 && (y0 >= 110 || y1 >= 110);
}

inline DecodedField DecodeP20GreenBar(
    std::span<const uint8_t> container,
    int row_bytes,
    FieldParity parity) noexcept {
    if (row_bytes < kWidth * 2 ||
        container.size() < static_cast<size_t>(row_bytes) * static_cast<size_t>(kHeight)) {
        return {};
    }

    DecodedField best{};
    for (int residue = 0; residue < kResidueCount; ++residue) {
        const int bar_left = kBarX + residue * kBarStep;
        int matching_scanlines = 0;
        for (int y = kBarTop + static_cast<int>(parity); y < kBarBottom; y += 2) {
            const auto* row = container.data() + static_cast<size_t>(y) * static_cast<size_t>(row_bytes);
            bool green = false;
            for (int x = bar_left - 2; x <= bar_left + 18; x += 2) {
                const auto offset = static_cast<size_t>(x) * 2;
                if (IsP20Green(row[offset], row[offset + 1], row[offset + 2], row[offset + 3])) {
                    green = true;
                    break;
                }
            }
            matching_scanlines += green ? 1 : 0;
        }
        if (matching_scanlines > best.matching_scanlines) {
            best.matching_scanlines = matching_scanlines;
            best.residue = static_cast<uint8_t>(residue);
        }
    }

    if (best.matching_scanlines < kMinimumGreenScanlines) {
        best.residue.reset();
    }
    return best;
}

inline std::string HashFieldFNV1a64(
    std::span<const uint8_t> container,
    int row_bytes,
    FieldParity parity) {
    constexpr uint64_t kOffsetBasis = 14695981039346656037ULL;
    constexpr uint64_t kPrime = 1099511628211ULL;

    uint64_t hash = kOffsetBasis;
    if (row_bytes >= kWidth * 2 &&
        container.size() >= static_cast<size_t>(row_bytes) * static_cast<size_t>(kHeight)) {
        for (int y = static_cast<int>(parity); y < kHeight; y += 2) {
            const auto* row = container.data() + static_cast<size_t>(y) * static_cast<size_t>(row_bytes);
            for (int byte = 0; byte < kWidth * 2; ++byte) {
                hash ^= row[byte];
                hash *= kPrime;
            }
        }
    }

    std::ostringstream output;
    output << std::hex << std::nouppercase << std::setfill('0') << std::setw(16) << hash;
    return output.str();
}

}  // namespace titulus::p20::capture
