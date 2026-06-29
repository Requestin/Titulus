#include "consumers/ffmpeg_consumer.h"

#include <cerrno>
#include <csignal>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

namespace bg {

namespace {

constexpr int kRestartExitCode = 43;

bool write_all_fd(int fd, const uint8_t* data, size_t bytes) {
    size_t offset = 0;
    while (offset < bytes) {
        const ssize_t n = ::write(fd, data + offset, bytes - offset);
        if (n > 0) {
            offset += static_cast<size_t>(n);
            continue;
        }
        if (n < 0 && errno == EINTR) continue;
        return false;
    }
    return true;
}

void close_fd(int& fd) {
    if (fd >= 0) {
        ::close(fd);
        fd = -1;
    }
}

}  // namespace

FfmpegConsumer::FfmpegConsumer(std::string stream_url, std::string ffmpeg_bin)
    : stream_url_(std::move(stream_url)),
      ffmpeg_bin_(std::move(ffmpeg_bin)),
      label_("stream[" + stream_url_ + "]") {}

FfmpegConsumer::~FfmpegConsumer() {
    Stop();
}

bool FfmpegConsumer::Start(int width, int height, int fps) {
    if (width <= 0 || height <= 0 || fps <= 0 || stream_url_.empty()) {
        std::fprintf(stderr, "bg_engine[stream]: invalid start params\n");
        return false;
    }

    width_ = width;
    height_ = height;
    fps_ = fps;
    const size_t bytes = static_cast<size_t>(width_) * static_cast<size_t>(height_) * 4u;
    black_frame_.assign(bytes, 0);

    if (!SpawnFfmpeg()) return false;
    running_.store(true, std::memory_order_release);
    worker_ = std::thread(&FfmpegConsumer::WorkerLoop, this);
    return true;
}

void FfmpegConsumer::OnFrame(const Frame& frame) {
    if (!running_.load(std::memory_order_acquire)) return;
    if (frame.width != width_ || frame.height != height_ || !frame.bgra) return;

    const size_t bytes = static_cast<size_t>(width_) * static_cast<size_t>(height_) * 4u;
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (latest_frame_.size() != bytes) latest_frame_.assign(bytes, 0);
        if (latest_seq_ != consumed_seq_) ++dropped_overwrite_;
        std::memcpy(latest_frame_.data(), frame.bgra, bytes);
        ++latest_seq_;
    }
    cv_.notify_one();
}

void FfmpegConsumer::Stop() {
    running_.store(false, std::memory_order_release);
    cv_.notify_all();

    if (worker_.joinable()) worker_.join();

    close_fd(write_fd_);

    if (child_pid_ > 0) {
        ::kill(child_pid_, SIGTERM);
        if (!WaitChildExit(1200)) {
            ::kill(child_pid_, SIGKILL);
            WaitChildExit(400);
        }
        child_pid_ = -1;
    }
}

const char* FfmpegConsumer::Label() const {
    return label_.c_str();
}

int FfmpegConsumer::PollExitCode() const {
    const int already = exit_code_.load(std::memory_order_acquire);
    if (already != 0) return already;

    if (child_pid_ > 0) {
        int status = 0;
        const pid_t rc = ::waitpid(child_pid_, &status, WNOHANG);
        if (rc == child_pid_) {
            child_pid_ = -1;
            exit_code_.store(kRestartExitCode, std::memory_order_release);
            if (WIFEXITED(status)) {
                std::fprintf(stderr, "bg_engine[stream]: ffmpeg exited %d (request restart)\n",
                             WEXITSTATUS(status));
            } else if (WIFSIGNALED(status)) {
                std::fprintf(stderr, "bg_engine[stream]: ffmpeg signaled %d (request restart)\n",
                             WTERMSIG(status));
            }
            return kRestartExitCode;
        }
    }
    return 0;
}

bool FfmpegConsumer::SpawnFfmpeg() {
    int fds[2] = {-1, -1};
    if (::pipe(fds) != 0) {
        std::fprintf(stderr, "bg_engine[stream]: pipe() failed: %s\n", std::strerror(errno));
        return false;
    }

    const std::string size = std::to_string(width_) + "x" + std::to_string(height_);
    const std::string fps = std::to_string(fps_);
    const std::string format = OutputFormatForUrl();

    std::vector<std::string> args = {
        ffmpeg_bin_,
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-f", "rawvideo",
        "-pix_fmt", "bgra",
        "-video_size", size,
        "-framerate", fps,
        "-i", "pipe:0",
        "-an",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-f", format,
        stream_url_,
    };

    std::vector<char*> argv;
    argv.reserve(args.size() + 1);
    for (auto& s : args) argv.push_back(const_cast<char*>(s.c_str()));
    argv.push_back(nullptr);

    const pid_t pid = ::fork();
    if (pid < 0) {
        std::fprintf(stderr, "bg_engine[stream]: fork() failed: %s\n", std::strerror(errno));
        ::close(fds[0]);
        ::close(fds[1]);
        return false;
    }
    if (pid == 0) {
        ::dup2(fds[0], STDIN_FILENO);
        ::close(fds[0]);
        ::close(fds[1]);
        ::execvp(argv[0], argv.data());
        std::fprintf(stderr, "bg_engine[stream]: execvp failed: %s\n", std::strerror(errno));
        _exit(127);
    }

    ::close(fds[0]);
    write_fd_ = fds[1];
    child_pid_ = pid;
    return true;
}

void FfmpegConsumer::WorkerLoop() {
    if (fps_ <= 0) return;

    const auto step = std::chrono::microseconds(1000000 / fps_);
    auto next_tick = std::chrono::steady_clock::now();
    std::vector<uint8_t> send = black_frame_;

    while (running_.load(std::memory_order_acquire)) {
        {
            std::unique_lock<std::mutex> lock(mu_);
            cv_.wait_until(lock, next_tick, [&] {
                return !running_.load(std::memory_order_acquire) || latest_seq_ != consumed_seq_;
            });
            if (latest_seq_ != consumed_seq_ && !latest_frame_.empty()) {
                send = latest_frame_;
                consumed_seq_ = latest_seq_;
            }
        }

        if (!running_.load(std::memory_order_acquire)) break;

        if (!WriteAll(send.data(), send.size())) {
            std::fprintf(stderr, "bg_engine[stream]: write to ffmpeg failed: %s\n", std::strerror(errno));
            exit_code_.store(kRestartExitCode, std::memory_order_release);
            running_.store(false, std::memory_order_release);
            break;
        }
        next_tick += step;
    }
}

bool FfmpegConsumer::WriteAll(const uint8_t* data, size_t bytes) {
    if (write_fd_ < 0) return false;
    return write_all_fd(write_fd_, data, bytes);
}

bool FfmpegConsumer::WaitChildExit(int timeout_ms) const {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
    while (std::chrono::steady_clock::now() < deadline) {
        int status = 0;
        const pid_t rc = ::waitpid(child_pid_, &status, WNOHANG);
        if (rc == child_pid_) return true;
        if (rc < 0 && errno == ECHILD) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return false;
}

std::string FfmpegConsumer::OutputFormatForUrl() const {
    if (stream_url_.rfind("rtmp://", 0) == 0 || stream_url_.rfind("rtmps://", 0) == 0) {
        return "flv";
    }
    if (stream_url_.rfind("srt://", 0) == 0) {
        return "mpegts";
    }
    if (stream_url_.rfind("udp://", 0) == 0) {
        return "mpegts";
    }
    return "mpegts";
}

}  // namespace bg
