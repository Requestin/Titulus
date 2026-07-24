// engine/src/vs/ndi_producer.cpp
//
// NDI ingest for Unreal frames. Without NDI SDK: file/stub producer so the
// VS pipeline and DeckLink OUT path can be developed and benched.

#include "vs/ndi_producer.h"
#include "vs/file_producer.h"

#include <cstdio>

#if defined(BG_ENABLE_NDI)
// Optional: place NDI SDK headers under engine/third_party/ndi/ and enable
// -DBG_ENABLE_NDI=ON. Real NDI receive loop lives behind this gate.
#include <Processing.NDI.Lib.h>
#include <atomic>
#include <chrono>
#include <thread>
#include <vector>
#endif

namespace bg {
namespace vs {

#if defined(BG_ENABLE_NDI)

class NdiProducer final : public Producer {
  public:
    explicit NdiProducer(std::string source_name)
        : source_name_(std::move(source_name)), label_("ndi[" + source_name_ + "]") {}
    ~NdiProducer() override { Stop(); }

    bool Start(int width, int height, int fps) override {
        if (!NDIlib_initialize()) {
            std::fprintf(stderr, "bg_vs_engine: NDIlib_initialize failed\n");
            return false;
        }
        width_ = width;
        height_ = height;
        fps_ = fps > 0 ? fps : 50;
        NDIlib_recv_create_v3_t desc;
        desc.source_to_connect_to.p_ndi_name = source_name_.c_str();
        desc.color_format = NDIlib_recv_color_format_BGRX_BGRA;
        desc.bandwidth = NDIlib_recv_bandwidth_highest;
        desc.allow_video_fields = false;
        recv_ = NDIlib_recv_create_v3(&desc);
        if (!recv_) {
            std::fprintf(stderr, "bg_vs_engine: NDIlib_recv_create_v3 failed for '%s'\n",
                         source_name_.c_str());
            NDIlib_destroy();
            return false;
        }
        running_.store(true);
        thread_ = std::thread([this] { ThreadMain(); });
        return true;
    }

    void Stop() override {
        if (!running_.exchange(false)) return;
        if (thread_.joinable()) thread_.join();
        if (recv_) {
            NDIlib_recv_destroy(recv_);
            recv_ = nullptr;
        }
        NDIlib_destroy();
    }

    const char* Label() const override { return label_.c_str(); }
    LatestFrameBuffer& Buffer() override { return buffer_; }

  private:
    void ThreadMain() {
        while (running_.load()) {
            NDIlib_video_frame_v2_t video;
            const auto type = NDIlib_recv_capture_v2(recv_, &video, nullptr, nullptr, 100);
            if (type == NDIlib_frame_type_video) {
                // Pack to channel size if needed (nearest: center-crop / letterbox later).
                if (video.p_data && video.xres > 0 && video.yres > 0) {
                    if (video.xres == width_ && video.yres == height_
                        && video.line_stride_in_bytes == width_ * 4) {
                        buffer_.Publish(reinterpret_cast<const uint8_t*>(video.p_data),
                                        width_, height_);
                    } else {
                        // Simple nearest scale into channel frame.
                        scratch_.assign(static_cast<size_t>(width_) * static_cast<size_t>(height_) * 4u, 0);
                        for (int y = 0; y < height_; ++y) {
                            const int sy = y * video.yres / height_;
                            const uint8_t* src_row =
                                reinterpret_cast<const uint8_t*>(video.p_data)
                                + static_cast<size_t>(sy) * static_cast<size_t>(video.line_stride_in_bytes);
                            uint8_t* dst_row = scratch_.data()
                                + static_cast<size_t>(y) * static_cast<size_t>(width_) * 4u;
                            for (int x = 0; x < width_; ++x) {
                                const int sx = x * video.xres / width_;
                                const uint8_t* p = src_row + static_cast<size_t>(sx) * 4u;
                                dst_row[x * 4 + 0] = p[0];
                                dst_row[x * 4 + 1] = p[1];
                                dst_row[x * 4 + 2] = p[2];
                                dst_row[x * 4 + 3] = 255;
                            }
                        }
                        buffer_.Publish(scratch_.data(), width_, height_);
                    }
                }
                NDIlib_recv_free_video_v2(recv_, &video);
            }
        }
    }

    std::string source_name_;
    std::string label_;
    int width_ = 1920;
    int height_ = 1080;
    int fps_ = 50;
    NDIlib_recv_instance_t recv_ = nullptr;
    LatestFrameBuffer buffer_;
    std::atomic<bool> running_{false};
    std::thread thread_;
    std::vector<uint8_t> scratch_;
};

std::unique_ptr<Producer> MakeUnrealProducer(const std::string& ndi_source,
                                             const std::string& bg_file) {
    if (!ndi_source.empty()) {
        return std::make_unique<NdiProducer>(ndi_source);
    }
    return std::make_unique<FileProducer>(bg_file, "flat", "unreal_file");
}

#else

std::unique_ptr<Producer> MakeUnrealProducer(const std::string& ndi_source,
                                             const std::string& bg_file) {
    if (!ndi_source.empty()) {
        std::fprintf(stderr,
                     "bg_vs_engine: NDI source '%s' requested but BG_ENABLE_NDI off — using file/stub\n",
                     ndi_source.c_str());
    }
    return std::make_unique<FileProducer>(bg_file, "flat", "unreal_stub");
}

#endif

}  // namespace vs
}  // namespace bg
