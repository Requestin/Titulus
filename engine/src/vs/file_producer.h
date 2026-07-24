// engine/src/vs/file_producer.h — raw BGRA file / synthetic color producer (stubs).

#ifndef BG_VS_FILE_PRODUCER_H
#define BG_VS_FILE_PRODUCER_H

#include "vs/producer.h"

#include <atomic>
#include <string>
#include <thread>

namespace bg {
namespace vs {

class FileProducer final : public Producer {
  public:
    // path empty → synthetic pattern (green or blueish for chroma tests).
    // pattern: "green_screen" | "blue_screen" | "bars" | "flat"
    FileProducer(std::string path, std::string pattern, std::string label);
    ~FileProducer() override;

    bool Start(int width, int height, int fps) override;
    void Stop() override;
    const char* Label() const override;
    LatestFrameBuffer& Buffer() override { return buffer_; }

  private:
    void ThreadMain();
    void FillSynthetic(std::vector<uint8_t>& out, int w, int h) const;
    bool LoadFile(std::vector<uint8_t>& out, int w, int h) const;

    std::string path_;
    std::string pattern_;
    std::string label_;
    int width_ = 0;
    int height_ = 0;
    int fps_ = 50;
    LatestFrameBuffer buffer_;
    std::atomic<bool> running_{false};
    std::thread thread_;
};

}  // namespace vs
}  // namespace bg

#endif
