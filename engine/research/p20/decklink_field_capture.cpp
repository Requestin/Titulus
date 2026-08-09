#include "decklink_field_decode.h"

#include "DeckLinkAPI.h"

#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace {

using titulus::p20::capture::DecodedField;
using titulus::p20::capture::DecodeP20GreenBar;
using titulus::p20::capture::FieldOrder;
using titulus::p20::capture::FieldParities;
using titulus::p20::capture::FieldParity;
using titulus::p20::capture::FieldParityName;
using titulus::p20::capture::HashFieldFNV1a64;
using titulus::p20::capture::kHeight;
using titulus::p20::capture::kWidth;

constexpr std::string_view kCsvHeader =
    "unix_us,output_channel,capture_input,field_index,semantic_id,"
    "field_parity,expected_parity,frame_hash\n";
constexpr int kDefaultDeviceIndex = 2;
constexpr int kDefaultDurationSeconds = 30;
constexpr int kMaximumDurationSeconds = 3600;

struct Options {
    int device_index = kDefaultDeviceIndex;
    int duration_seconds = kDefaultDurationSeconds;
    FieldOrder field_order = FieldOrder::TopFieldFirst;
    std::string output_channel = "unknown";
    std::string capture_input = "decklink-2";
    std::filesystem::path csv_path;
};

bool IsSafeCsvToken(std::string_view value) {
    if (value.empty() || value.size() > 80) return false;
    for (const unsigned char character : value) {
        const bool allowed =
            (character >= 'a' && character <= 'z') ||
            (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') ||
            character == '-' || character == '_' || character == '.' || character == ':';
        if (!allowed) return false;
    }
    return true;
}

std::optional<int> ParseNonnegativeInt(std::string_view value) {
    if (value.empty()) return std::nullopt;
    int result = 0;
    const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), result);
    if (error != std::errc{} || end != value.data() + value.size() || result < 0) {
        return std::nullopt;
    }
    return result;
}

void PrintUsage(FILE* stream) {
    std::fprintf(
        stream,
        "Usage: decklink_field_capture --csv=PATH [options]\n"
        "\n"
        "Observer-only HD1080i50 UYVY input capture. It never writes raw video.\n"
        "Options:\n"
        "  --device-index=N          DeckLink input index (default: 2)\n"
        "  --duration-sec=N          Bounded capture, 1..3600 (default: 30)\n"
        "  --field-order=tff|bff     Emit field order (default: tff)\n"
        "  --output-channel=TOKEN    Safe CSV token (default: unknown)\n"
        "  --capture-input=TOKEN     Safe CSV token (default: decklink-2)\n"
        "  --csv=PATH                New output CSV; existing files are refused\n"
        "  --help\n");
}

std::optional<Options> ParseOptions(int argc, char* argv[]) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::string_view argument{argv[index]};
        if (argument == "--help") {
            PrintUsage(stdout);
            return std::nullopt;
        }

        const auto equals = argument.find('=');
        if (equals == std::string_view::npos || !argument.starts_with("--")) {
            std::fprintf(stderr, "[p20-field-capture] invalid option: %.*s\n",
                         static_cast<int>(argument.size()), argument.data());
            return std::nullopt;
        }
        const std::string_view name = argument.substr(2, equals - 2);
        const std::string_view value = argument.substr(equals + 1);
        if (name == "device-index") {
            const auto parsed = ParseNonnegativeInt(value);
            if (!parsed) {
                std::fprintf(stderr, "[p20-field-capture] --device-index must be non-negative\n");
                return std::nullopt;
            }
            options.device_index = *parsed;
            if (options.capture_input == "decklink-2") {
                options.capture_input = "decklink-" + std::to_string(options.device_index);
            }
        } else if (name == "duration-sec") {
            const auto parsed = ParseNonnegativeInt(value);
            if (!parsed || *parsed < 1 || *parsed > kMaximumDurationSeconds) {
                std::fprintf(stderr, "[p20-field-capture] --duration-sec must be 1..%d\n",
                             kMaximumDurationSeconds);
                return std::nullopt;
            }
            options.duration_seconds = *parsed;
        } else if (name == "field-order") {
            if (value == "tff") {
                options.field_order = FieldOrder::TopFieldFirst;
            } else if (value == "bff") {
                options.field_order = FieldOrder::BottomFieldFirst;
            } else {
                std::fprintf(stderr, "[p20-field-capture] --field-order must be tff|bff\n");
                return std::nullopt;
            }
        } else if (name == "output-channel") {
            if (!IsSafeCsvToken(value)) {
                std::fprintf(stderr, "[p20-field-capture] --output-channel is not a safe CSV token\n");
                return std::nullopt;
            }
            options.output_channel = value;
        } else if (name == "capture-input") {
            if (!IsSafeCsvToken(value)) {
                std::fprintf(stderr, "[p20-field-capture] --capture-input is not a safe CSV token\n");
                return std::nullopt;
            }
            options.capture_input = value;
        } else if (name == "csv") {
            if (value.empty()) {
                std::fprintf(stderr, "[p20-field-capture] --csv requires a path\n");
                return std::nullopt;
            }
            options.csv_path = std::string{value};
        } else {
            std::fprintf(stderr, "[p20-field-capture] unknown option: %.*s\n",
                         static_cast<int>(name.size()), name.data());
            return std::nullopt;
        }
    }

    if (options.csv_path.empty()) {
        std::fprintf(stderr, "[p20-field-capture] --csv is required\n");
        return std::nullopt;
    }
    return options;
}

uint64_t UnixMicroseconds() noexcept {
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(now).count());
}

template <typename T>
void ReleaseCom(T*& pointer) noexcept {
    if (pointer != nullptr) {
        pointer->Release();
        pointer = nullptr;
    }
}

template <typename T>
class ComRef final {
  public:
    ~ComRef() {
        ReleaseCom(pointer_);
    }

    T* get() const noexcept {
        return pointer_;
    }

    void** receive() noexcept {
        ReleaseCom(pointer_);
        return reinterpret_cast<void**>(&pointer_);
    }

  private:
    T* pointer_ = nullptr;
};

class CsvWriter {
  public:
    bool OpenNew(const std::filesystem::path& path) {
        std::error_code error;
        if (std::filesystem::exists(path, error)) {
            std::fprintf(stderr, "[p20-field-capture] refusing to overwrite CSV: %s\n",
                         path.c_str());
            return false;
        }
        if (error) {
            std::fprintf(stderr, "[p20-field-capture] cannot inspect CSV path: %s\n",
                         error.message().c_str());
            return false;
        }

        stream_.open(path, std::ios::out | std::ios::binary);
        if (!stream_.is_open()) {
            std::fprintf(stderr, "[p20-field-capture] cannot open CSV: %s\n", path.c_str());
            return false;
        }
        stream_ << kCsvHeader;
        return static_cast<bool>(stream_);
    }

    bool Write(
        uint64_t unix_us,
        std::string_view output_channel,
        std::string_view capture_input,
        uint64_t field_index,
        const std::optional<int64_t>& semantic_id,
        FieldParity field_parity,
        FieldParity expected_parity,
        std::string_view frame_hash) {
        stream_ << unix_us << ',' << output_channel << ',' << capture_input << ','
                << field_index << ',';
        if (semantic_id) stream_ << *semantic_id;
        stream_ << ',' << FieldParityName(field_parity) << ','
                << FieldParityName(expected_parity) << ',' << frame_hash << '\n';
        return static_cast<bool>(stream_);
    }

    bool Flush() {
        stream_.flush();
        return static_cast<bool>(stream_);
    }

  private:
    std::ofstream stream_;
};

class CaptureSession;

class InputCallback final : public IDeckLinkInputCallback {
  public:
    explicit InputCallback(CaptureSession& session) : session_(session) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* result) override;
    ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    HRESULT VideoInputFormatChanged(
        BMDVideoInputFormatChangedEvents,
        IDeckLinkDisplayMode*,
        BMDDetectedVideoInputFormatFlags) override {
        return S_OK;
    }
    HRESULT VideoInputFrameArrived(
        IDeckLinkVideoInputFrame* video_frame,
        IDeckLinkAudioInputPacket*) override;

  private:
    CaptureSession& session_;
};

class CaptureSession {
  public:
    explicit CaptureSession(Options options)
        : options_(std::move(options)), callback_(*this) {}

    ~CaptureSession() {
        Stop();
        ReleaseCom(input_);
        ReleaseCom(device_);
    }

    bool Start() {
        if (!writer_.OpenNew(options_.csv_path)) return false;

        IDeckLinkIterator* iterator = CreateDeckLinkIteratorInstance();
        if (iterator == nullptr) {
            std::fprintf(stderr, "[p20-field-capture] CreateDeckLinkIteratorInstance failed\n");
            return false;
        }

        int current_index = 0;
        IDeckLink* current = nullptr;
        while (iterator->Next(&current) == S_OK) {
            if (current_index == options_.device_index) {
                device_ = current;
                current = nullptr;
                break;
            }
            current->Release();
            current = nullptr;
            ++current_index;
        }
        iterator->Release();

        if (device_ == nullptr) {
            std::fprintf(stderr, "[p20-field-capture] DeckLink device index %d not found\n",
                         options_.device_index);
            return false;
        }
        if (device_->QueryInterface(
                IID_IDeckLinkInput, reinterpret_cast<void**>(&input_)) != S_OK ||
            input_ == nullptr) {
            std::fprintf(stderr, "[p20-field-capture] IDeckLinkInput unavailable\n");
            return false;
        }

        BMDDisplayMode actual_mode = bmdModeUnknown;
        bool supported = false;
        if (input_->DoesSupportVideoMode(
                bmdVideoConnectionUnspecified,
                bmdModeHD1080i50,
                bmdFormat8BitYUV,
                bmdNoVideoInputConversion,
                bmdSupportedVideoModeDefault,
                &actual_mode,
                &supported) != S_OK ||
            !supported || actual_mode != bmdModeHD1080i50) {
            std::fprintf(stderr,
                         "[p20-field-capture] input does not support HD1080i50 UYVY without conversion\n");
            return false;
        }
        if (input_->SetCallback(&callback_) != S_OK) {
            std::fprintf(stderr, "[p20-field-capture] SetCallback failed\n");
            return false;
        }
        callback_installed_ = true;
        if (input_->EnableVideoInput(
                bmdModeHD1080i50, bmdFormat8BitYUV, bmdVideoInputFlagDefault) != S_OK) {
            std::fprintf(stderr, "[p20-field-capture] EnableVideoInput(HD1080i50, UYVY) failed\n");
            return false;
        }
        video_enabled_ = true;
        if (input_->StartStreams() != S_OK) {
            std::fprintf(stderr, "[p20-field-capture] StartStreams failed\n");
            return false;
        }
        streams_started_ = true;
        return true;
    }

    int WaitForDuration() {
        std::unique_lock<std::mutex> lock(wait_mutex_);
        const bool stopped_early = wait_cv_.wait_for(
            lock,
            std::chrono::seconds(options_.duration_seconds),
            [this] { return stop_requested_.load(std::memory_order_acquire); });
        if (stopped_early) {
            return callback_failures_.load(std::memory_order_relaxed) == 0 ? 0 : 1;
        }
        return 0;
    }

    void Stop() noexcept {
        stop_requested_.store(true, std::memory_order_release);
        wait_cv_.notify_all();

        if (input_ == nullptr) return;
        if (streams_started_) {
            input_->StopStreams();
            streams_started_ = false;
        }
        if (video_enabled_) {
            input_->DisableVideoInput();
            video_enabled_ = false;
        }
        if (callback_installed_) {
            input_->SetCallback(nullptr);
            callback_installed_ = false;
        }
    }

    void PrintSummary() {
        const bool flushed = writer_.Flush();
        std::fprintf(
            stderr,
            "[p20-field-capture] fields=%llu containers=%llu no_source=%llu "
            "invalid=%llu write_failures=%llu csv_flush=%s\n",
            static_cast<unsigned long long>(fields_.load(std::memory_order_relaxed)),
            static_cast<unsigned long long>(containers_.load(std::memory_order_relaxed)),
            static_cast<unsigned long long>(no_source_frames_.load(std::memory_order_relaxed)),
            static_cast<unsigned long long>(invalid_frames_.load(std::memory_order_relaxed)),
            static_cast<unsigned long long>(callback_failures_.load(std::memory_order_relaxed)),
            flushed ? "ok" : "failed");
    }

    HRESULT OnFrame(IDeckLinkVideoInputFrame* video_frame) noexcept {
        if (video_frame == nullptr || stop_requested_.load(std::memory_order_acquire)) {
            return S_OK;
        }

        try {
            const uint64_t unix_us = UnixMicroseconds();
            if (video_frame->GetFlags() & bmdFrameHasNoInputSource) {
                no_source_frames_.fetch_add(1, std::memory_order_relaxed);
                return S_OK;
            }
            if (video_frame->GetWidth() != kWidth || video_frame->GetHeight() != kHeight ||
                video_frame->GetPixelFormat() != bmdFormat8BitYUV) {
                invalid_frames_.fetch_add(1, std::memory_order_relaxed);
                return S_OK;
            }

            ComRef<IDeckLinkVideoBuffer> video_buffer;
            if (video_frame->QueryInterface(
                    IID_IDeckLinkVideoBuffer,
                    video_buffer.receive()) != S_OK ||
                video_buffer.get() == nullptr) {
                invalid_frames_.fetch_add(1, std::memory_order_relaxed);
                return S_OK;
            }
            void* bytes = nullptr;
            uint64_t buffer_size = 0;
            const HRESULT get_bytes = video_buffer.get()->GetBytes(&bytes);
            if (get_bytes != S_OK || video_buffer.get()->GetSize(&buffer_size) != S_OK ||
                bytes == nullptr || video_frame->GetRowBytes() < kWidth * 2) {
                invalid_frames_.fetch_add(1, std::memory_order_relaxed);
                return S_OK;
            }

            const int row_bytes = video_frame->GetRowBytes();
            const auto byte_count =
                static_cast<size_t>(row_bytes) * static_cast<size_t>(kHeight);
            if (buffer_size < byte_count) {
                invalid_frames_.fetch_add(1, std::memory_order_relaxed);
                return S_OK;
            }
            const auto container = std::span<const uint8_t>{
                static_cast<const uint8_t*>(bytes), byte_count};
            for (const FieldParity parity : FieldParities(options_.field_order)) {
                const DecodedField decoded = DecodeP20GreenBar(container, row_bytes, parity);
                const std::optional<int64_t> semantic_id =
                    decoded.residue ? UnwrapSemanticId(*decoded.residue) : std::nullopt;
                const uint64_t field_index = fields_.fetch_add(1, std::memory_order_relaxed);
                if (!writer_.Write(
                        unix_us,
                        options_.output_channel,
                        options_.capture_input,
                        field_index,
                        semantic_id,
                        parity,
                        parity,
                        HashFieldFNV1a64(container, row_bytes, parity))) {
                    callback_failures_.fetch_add(1, std::memory_order_relaxed);
                    stop_requested_.store(true, std::memory_order_release);
                    wait_cv_.notify_all();
                    return E_FAIL;
                }
            }
            containers_.fetch_add(1, std::memory_order_relaxed);
        } catch (...) {
            callback_failures_.fetch_add(1, std::memory_order_relaxed);
            stop_requested_.store(true, std::memory_order_release);
            wait_cv_.notify_all();
            return E_FAIL;
        }
        return S_OK;
    }

  private:
    std::optional<int64_t> UnwrapSemanticId(uint8_t residue) noexcept {
        if (!next_semantic_id_) {
            next_semantic_id_ = static_cast<int64_t>(residue) + 1;
            return static_cast<int64_t>(residue);
        }

        const int64_t expected = *next_semantic_id_;
        int64_t candidate = expected - (expected % titulus::p20::capture::kResidueCount) + residue;
        const int64_t difference = candidate - expected;
        if (difference > titulus::p20::capture::kResidueCount / 2) {
            candidate -= titulus::p20::capture::kResidueCount;
        } else if (difference < -titulus::p20::capture::kResidueCount / 2) {
            candidate += titulus::p20::capture::kResidueCount;
        }
        next_semantic_id_ = candidate + 1;
        return candidate;
    }

    Options options_;
    CsvWriter writer_;
    IDeckLink* device_ = nullptr;
    IDeckLinkInput* input_ = nullptr;
    InputCallback callback_;
    std::optional<int64_t> next_semantic_id_;
    std::mutex wait_mutex_;
    std::condition_variable wait_cv_;
    std::atomic<bool> stop_requested_{false};
    std::atomic<uint64_t> fields_{0};
    std::atomic<uint64_t> containers_{0};
    std::atomic<uint64_t> no_source_frames_{0};
    std::atomic<uint64_t> invalid_frames_{0};
    std::atomic<uint64_t> callback_failures_{0};
    bool callback_installed_ = false;
    bool video_enabled_ = false;
    bool streams_started_ = false;
};

HRESULT STDMETHODCALLTYPE InputCallback::QueryInterface(REFIID iid, LPVOID* result) {
    if (result == nullptr) return E_INVALIDARG;
    static constexpr REFIID kIidIUnknown{
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46};
    if (std::memcmp(&iid, &kIidIUnknown, sizeof(REFIID)) == 0 ||
        std::memcmp(&iid, &IID_IDeckLinkInputCallback, sizeof(REFIID)) == 0) {
        *result = this;
        AddRef();
        return S_OK;
    }
    *result = nullptr;
    return E_NOINTERFACE;
}

HRESULT STDMETHODCALLTYPE InputCallback::VideoInputFrameArrived(
    IDeckLinkVideoInputFrame* video_frame,
    IDeckLinkAudioInputPacket*) {
    return session_.OnFrame(video_frame);
}

}  // namespace

int main(int argc, char* argv[]) {
    const std::optional<Options> options = ParseOptions(argc, argv);
    if (!options) return argc > 1 && std::string_view{argv[1]} == "--help" ? 0 : 2;

    CaptureSession session{*options};
    if (!session.Start()) return 1;

    std::fprintf(
        stderr,
        "[p20-field-capture] capturing device=%d HD1080i50 UYVY for %ds; "
        "field_order=%s; csv=%s\n",
        options->device_index,
        options->duration_seconds,
        options->field_order == FieldOrder::TopFieldFirst ? "tff" : "bff",
        options->csv_path.c_str());

    const int wait_result = session.WaitForDuration();
    session.Stop();
    session.PrintSummary();
    return wait_result;
}
