#ifndef BG_ENGINE_CONSUMERS_FFMPEG_CONSUMER_H
#define BG_ENGINE_CONSUMERS_FFMPEG_CONSUMER_H

#include "consumers/consumer.h"

#include <atomic>
#include <sys/types.h>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace bg {

// Stream consumer: feeds raw BGRA frames to an ffmpeg child via stdin.
//
// - Input: Frame (BGRA, width*height*4, from CEF OnPaint)
// - Output: URL transport (SRT/RTMP/...)
//
// OnFrame never blocks on network IO; a worker thread keeps a latest-frame
// snapshot and writes it to ffmpeg on channel cadence.
class FfmpegConsumer final : public Consumer {
  public:
    explicit FfmpegConsumer(std::string stream_url, std::string ffmpeg_bin = "ffmpeg");
    ~FfmpegConsumer() override;

    bool Start(int width, int height, int fps) override;
    void OnFrame(const Frame& frame) override;
    void Stop() override;
    const char* Label() const override;
    int PollExitCode() const override;

  private:
    bool SpawnFfmpeg();
    void WorkerLoop();
    bool WriteAll(const uint8_t* data, size_t bytes);
    bool WaitChildExit(int timeout_ms) const;
    std::string OutputFormatForUrl() const;

    std::string stream_url_;
    std::string ffmpeg_bin_;
    std::string label_;

    int width_ = 0;
    int height_ = 0;
    int fps_ = 0;

    mutable int write_fd_ = -1;     // ffmpeg stdin (parent side)
    mutable pid_t child_pid_ = -1;  // ffmpeg process id

    mutable std::atomic<int> exit_code_{0};
    std::atomic<bool> running_{false};

    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::vector<uint8_t> latest_frame_;
    std::vector<uint8_t> black_frame_;
    uint64_t latest_seq_ = 0;
    uint64_t consumed_seq_ = 0;
    uint64_t dropped_overwrite_ = 0;

    std::thread worker_;
};

}  // namespace bg

#endif  // BG_ENGINE_CONSUMERS_FFMPEG_CONSUMER_H
