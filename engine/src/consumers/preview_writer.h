// engine/src/consumers/preview_writer.h
//
// Preview consumer — writes a throttled JPEG snapshot of the latest frame for
// the operator ProgramMonitor (DEVELOPMENT_PROMPT §9.6, NFR-2).
//
// Backend serves the latest JPEG via /api/preview/:channelId. We write to a
// ".tmp" file then atomic-rename so the reader never sees a half-written image.
// Quality 80, throttle default 10 fps (configurable via --preview-fps).
//
// stb_image_write (public domain) encodes the JPEG from the BGRA buffer; we
// down-sample to JPEG-quality 80 which is plenty for an operator monitor and
// keeps the encode fast on a single core.

#ifndef BG_ENGINE_CONSUMERS_PREVIEW_WRITER_H
#define BG_ENGINE_CONSUMERS_PREVIEW_WRITER_H

#include "consumers/consumer.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// stb_image_write is a single-header public-domain library (THIRD_PARTY_NOTICES).
// We implement only the JPEG write here.
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC
#include "stb_image_write.h"

namespace bg {

class PreviewWriter final : public Consumer {
  public:
    PreviewWriter(std::string out_path, int preview_fps)
        : out_path_(std::move(out_path)),
          min_interval_us_(preview_fps > 0 ? (1'000'000 / preview_fps) : 100'000) {}

    bool Start(int width, int height, int /*fps*/) override {
        if (out_path_.empty()) {
            std::fprintf(stderr, "bg_engine[preview]: --preview-out=PATH required\n");
            return false;
        }
        width_  = width;
        height_ = height;
        // Pre-size a row buffer for the JPEG encode (stb wants RGB; we strip
        // alpha inline). RGB stride = width*3.
        rgb_.assign(static_cast<size_t>(width) * static_cast<size_t>(height) * 3, 0);
        running_.store(true, std::memory_order_release);
        // Dedicated writer thread: the CEF UI thread must not block on JPEG
        // encode + fsync. It copies the latest BGRA and the thread encodes.
        thread_ = std::thread([this] { WriterLoop(); });
        return true;
    }

    void OnFrame(const Frame& frame) override {
        if (frame.width != width_ || frame.height != height_) return;
        // Cheap lock-free latest-frame copy for the writer thread.
        std::lock_guard<std::mutex> lock(mu_);
        const size_t bytes = static_cast<size_t>(frame.width) * static_cast<size_t>(frame.height) * 4;
        if (bgra_.size() != bytes) bgra_.assign(bytes, 0);
        std::memcpy(bgra_.data(), frame.bgra, bytes);
        have_frame_.store(true, std::memory_order_release);
        // Wake the writer if it's sleeping past the next deadline.
        cv_.notify_one();
    }

    void Stop() override {
        running_.store(false, std::memory_order_release);
        cv_.notify_all();
        if (thread_.joinable()) thread_.join();
    }

    const char* Label() const override { return "preview"; }

  private:
    void WriterLoop() {
        auto last = std::chrono::steady_clock::now();
        while (running_.load(std::memory_order_acquire)) {
            // Wait until at least min_interval elapsed or we're stopped.
            std::unique_lock<std::mutex> lock(mu_);
            cv_.wait_for(lock, std::chrono::microseconds(min_interval_us_));
            if (!have_frame_.load(std::memory_order_acquire)) continue;
            // Throttle: only encode at most preview_fps per second.
            const auto now = std::chrono::steady_clock::now();
            const auto since = std::chrono::duration_cast<std::chrono::microseconds>(now - last).count();
            if (since < static_cast<int64_t>(min_interval_us_)) continue;
            last = now;
            // Strip alpha -> RGB into rgb_ (BGRA byte order: B,G,R,A).
            const int n = width_ * height_;
            const uint8_t* src = bgra_.data();
            uint8_t* dst = rgb_.data();
            for (int i = 0; i < n; ++i) {
                dst[i * 3 + 0] = src[i * 4 + 2];  // R
                dst[i * 3 + 1] = src[i * 4 + 1];  // G
                dst[i * 3 + 2] = src[i * 4 + 0];  // B
            }
            lock.unlock();

            // Atomic write: encode to ".tmp", then rename onto the final path
            // so the backend reader never sees a partial JPEG.
            const std::string tmp = out_path_ + ".tmp";
            const int ok = stbi_write_jpg(tmp.c_str(), width_, height_, 3, rgb_.data(), 80);
            if (ok) {
                if (std::rename(tmp.c_str(), out_path_.c_str()) != 0) {
                    std::remove(tmp.c_str());
                }
            }
        }
    }

    std::string out_path_;
    int         width_  = 0;
    int         height_ = 0;
    uint64_t    min_interval_us_;

    std::mutex             mu_;
    std::condition_variable cv_;
    std::vector<uint8_t>   bgra_;
    std::vector<uint8_t>   rgb_;
    std::atomic<bool>      have_frame_{false};
    std::atomic<bool>      running_{false};
    std::thread            thread_;
};

}  // namespace bg

#endif  // BG_ENGINE_CONSUMERS_PREVIEW_WRITER_H
