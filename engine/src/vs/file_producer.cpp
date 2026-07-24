// engine/src/vs/file_producer.cpp

#include "vs/file_producer.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>

namespace bg {
namespace vs {

FileProducer::FileProducer(std::string path, std::string pattern, std::string label)
    : path_(std::move(path)), pattern_(std::move(pattern)), label_(std::move(label)) {}

FileProducer::~FileProducer() { Stop(); }

bool FileProducer::Start(int width, int height, int fps) {
    if (running_.load()) return true;
    width_ = width;
    height_ = height;
    fps_ = fps > 0 ? fps : 50;
    running_.store(true);
    thread_ = std::thread([this] { ThreadMain(); });
    return true;
}

void FileProducer::Stop() {
    if (!running_.exchange(false)) return;
    if (thread_.joinable()) thread_.join();
}

const char* FileProducer::Label() const { return label_.c_str(); }

void FileProducer::FillSynthetic(std::vector<uint8_t>& out, int w, int h) const {
    out.resize(static_cast<size_t>(w) * static_cast<size_t>(h) * 4u);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const size_t i = (static_cast<size_t>(y) * static_cast<size_t>(w) + static_cast<size_t>(x)) * 4u;
            uint8_t b = 0, g = 0, r = 0, a = 255;
            if (pattern_ == "green_screen") {
                // Talent rectangle in center; green elsewhere.
                const bool talent = (x > w / 3 && x < 2 * w / 3 && y > h / 4 && y < 3 * h / 4);
                if (talent) {
                    b = 40; g = 60; r = 200;  // reddish talent
                } else {
                    b = 20; g = 180; r = 20;  // chroma green
                }
            } else if (pattern_ == "blue_screen") {
                const bool talent = (x > w / 3 && x < 2 * w / 3 && y > h / 4 && y < 3 * h / 4);
                if (talent) {
                    b = 40; g = 60; r = 200;
                } else {
                    b = 200; g = 40; r = 20;
                }
            } else if (pattern_ == "bars") {
                const int bar = (x * 8) / w;
                static const uint8_t cols[8][3] = {
                    {180, 180, 180}, {40, 180, 180}, {180, 180, 40}, {40, 180, 40},
                    {180, 40, 180}, {40, 40, 180}, {180, 40, 40}, {20, 20, 20},
                };
                const int c = bar < 0 ? 0 : (bar > 7 ? 7 : bar);
                b = cols[c][0]; g = cols[c][1]; r = cols[c][2];
            } else {
                // flat dark blue BG (Unreal stub)
                b = 80; g = 40; r = 20;
            }
            out[i + 0] = b;
            out[i + 1] = g;
            out[i + 2] = r;
            out[i + 3] = a;
        }
    }
}

bool FileProducer::LoadFile(std::vector<uint8_t>& out, int w, int h) const {
    if (path_.empty()) return false;
    const size_t need = static_cast<size_t>(w) * static_cast<size_t>(h) * 4u;
    std::ifstream in(path_, std::ios::binary);
    if (!in) return false;
    out.resize(need);
    in.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(need));
    return static_cast<size_t>(in.gcount()) == need;
}

void FileProducer::ThreadMain() {
    const auto interval = std::chrono::microseconds(1'000'000 / fps_);
    std::vector<uint8_t> frame;
    while (running_.load()) {
        const auto t0 = std::chrono::steady_clock::now();
        if (!LoadFile(frame, width_, height_)) {
            FillSynthetic(frame, width_, height_);
        }
        buffer_.Publish(frame.data(), width_, height_);
        const auto elapsed = std::chrono::steady_clock::now() - t0;
        if (elapsed < interval) {
            std::this_thread::sleep_for(interval - elapsed);
        }
    }
}

}  // namespace vs
}  // namespace bg
