#include "consumers/decklink_consumer.h"

#include "DeckLinkAPI.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <dlfcn.h>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace bg {

namespace {

template <typename T>
void release_com(T*& ptr) {
    if (ptr) {
        ptr->Release();
        ptr = nullptr;
    }
}

std::optional<BMDDisplayMode> parse_display_mode(const std::string& name) {
    if (name == "NTSC") return bmdModeNTSC;
    if (name == "PAL") return bmdModePAL;
    if (name == "HD1080i50") return bmdModeHD1080i50;
    if (name == "HD1080i5994") return bmdModeHD1080i5994;
    if (name == "HD1080i6000") return bmdModeHD1080i6000;
    if (name == "HD1080p25") return bmdModeHD1080p25;
    if (name == "HD1080p2997") return bmdModeHD1080p2997;
    if (name == "HD1080p30") return bmdModeHD1080p30;
    if (name == "HD1080p50") return bmdModeHD1080p50;
    if (name == "HD1080p5994") return bmdModeHD1080p5994;
    if (name == "HD1080p6000") return bmdModeHD1080p6000;
    if (name == "HD720p50") return bmdModeHD720p50;
    if (name == "HD720p5994") return bmdModeHD720p5994;
    if (name == "HD720p60") return bmdModeHD720p60;
    return std::nullopt;
}

void log_msg(const std::string& label, const std::string& msg) {
    std::fprintf(stderr, "bg_engine[%s]: %s\n", label.c_str(), msg.c_str());
}

struct BufferedFrame {
    std::vector<uint8_t> bytes;
    uint64_t seq = 0;
};

class OwnedDecklinkFrame final : public IDeckLinkVideoFrame, public IDeckLinkVideoBuffer {
  public:
    OwnedDecklinkFrame(int width, int height, int row_bytes, std::vector<uint8_t>&& data)
        : width_(width), height_(height), row_bytes_(row_bytes), data_(std::move(data)) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* ppv) override {
        if (!ppv) return E_INVALIDARG;
        const REFIID iid_iunknown = IID_IUnknown;
        if (std::memcmp(&iid, &iid_iunknown, sizeof(REFIID)) == 0) {
            *ppv = static_cast<IUnknown*>(static_cast<IDeckLinkVideoFrame*>(this));
            AddRef();
            return S_OK;
        }
        if (std::memcmp(&iid, &IID_IDeckLinkVideoFrame, sizeof(REFIID)) == 0) {
            *ppv = static_cast<IDeckLinkVideoFrame*>(this);
            AddRef();
            return S_OK;
        }
        if (std::memcmp(&iid, &IID_IDeckLinkVideoBuffer, sizeof(REFIID)) == 0) {
            *ppv = static_cast<IDeckLinkVideoBuffer*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override {
        return ++ref_count_;
    }

    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG ref = --ref_count_;
        if (ref == 0) delete this;
        return ref;
    }

    long GetWidth() override { return width_; }
    long GetHeight() override { return height_; }
    long GetRowBytes() override { return row_bytes_; }
    BMDPixelFormat GetPixelFormat() override { return bmdFormat8BitBGRA; }
    BMDFrameFlags GetFlags() override { return bmdFrameFlagDefault; }
    HRESULT GetTimecode(BMDTimecodeFormat, IDeckLinkTimecode**) override { return S_FALSE; }
    HRESULT GetAncillaryData(IDeckLinkVideoFrameAncillary**) override { return S_FALSE; }

    HRESULT GetBytes(void** buffer) override {
        if (!buffer) return E_INVALIDARG;
        *buffer = data_.data();
        return S_OK;
    }
    HRESULT GetSize(uint64_t* size) override {
        if (!size) return E_INVALIDARG;
        *size = data_.size();
        return S_OK;
    }
    HRESULT StartAccess(BMDBufferAccessFlags) override { return S_OK; }
    HRESULT EndAccess(BMDBufferAccessFlags) override { return S_OK; }

  private:
    std::atomic<ULONG> ref_count_{1};
    int width_ = 0;
    int height_ = 0;
    int row_bytes_ = 0;
    std::vector<uint8_t> data_;
};

}  // namespace

struct DecklinkConsumer::Impl {
    explicit Impl(int device_index, std::string display_mode, KeyerMode keyer_mode)
        : device_index_(device_index),
          display_mode_name_(std::move(display_mode)),
          keyer_mode_(keyer_mode) {}

    class OutputCallback final : public IDeckLinkVideoOutputCallback {
      public:
        explicit OutputCallback(Impl* owner) : owner_(owner) {}

        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* ppv) override {
            if (!ppv) return E_INVALIDARG;
            const REFIID iid_iunknown = IID_IUnknown;
            if (std::memcmp(&iid, &iid_iunknown, sizeof(REFIID)) == 0 ||
                std::memcmp(&iid, &IID_IDeckLinkVideoOutputCallback, sizeof(REFIID)) == 0) {
                *ppv = this;
                return S_OK;
            }
            *ppv = nullptr;
            return E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
        ULONG STDMETHODCALLTYPE Release() override { return 1; }

        HRESULT STDMETHODCALLTYPE ScheduledPlaybackHasStopped() override {
            return S_OK;
        }

        HRESULT STDMETHODCALLTYPE ScheduledFrameCompleted(
            IDeckLinkVideoFrame* completed_frame,
            BMDOutputFrameCompletionResult result) override {
            if (!owner_) return E_FAIL;
            return owner_->OnScheduledFrameCompleted(completed_frame, result);
        }

      private:
        Impl* owner_;
    };

    class ProfileCallback final : public IDeckLinkProfileCallback {
      public:
        explicit ProfileCallback(Impl* owner) : owner_(owner) {}

        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* ppv) override {
            if (!ppv) return E_INVALIDARG;
            const REFIID iid_iunknown = IID_IUnknown;
            if (std::memcmp(&iid, &iid_iunknown, sizeof(REFIID)) == 0 ||
                std::memcmp(&iid, &IID_IDeckLinkProfileCallback, sizeof(REFIID)) == 0) {
                *ppv = this;
                return S_OK;
            }
            *ppv = nullptr;
            return E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
        ULONG STDMETHODCALLTYPE Release() override { return 1; }

        HRESULT STDMETHODCALLTYPE ProfileChanging(
            IDeckLinkProfile* /*profile_to_be_activated*/,
            bool streams_will_be_forced_to_stop) override {
            if (!owner_) return E_FAIL;
            if (streams_will_be_forced_to_stop) {
                owner_->RequestRestart(42);
                log_msg(owner_->label_, "profile change requested, scheduling exit 42");
            }
            return S_OK;
        }

        HRESULT STDMETHODCALLTYPE ProfileActivated(
            IDeckLinkProfile* /*activated_profile*/) override {
            return S_OK;
        }

      private:
        Impl* owner_;
    };

    ~Impl() {
        Stop();
    }

    bool Start(int width, int height, int fps) {
        width_ = width;
        height_ = height;
        fps_ = fps;
        frame_bytes_ = static_cast<size_t>(width_) * static_cast<size_t>(height_) * 4;
        last_frame_.assign(frame_bytes_, 0);
        black_frame_.assign(frame_bytes_, 0);

        if (!LoadDeckLinkRuntime()) return false;

        IDeckLinkIterator* iterator = create_iterator_ ? create_iterator_() : nullptr;
        if (!iterator) {
            log_msg(label_, "CreateDeckLinkIteratorInstance failed");
            return false;
        }

        bool found = false;
        int current_index = 0;
        IDeckLink* current = nullptr;
        while (iterator->Next(&current) == S_OK) {
            if (current_index == device_index_) {
                device_ = current;
                found = true;
                break;
            }
            current->Release();
            current = nullptr;
            ++current_index;
        }
        iterator->Release();

        if (!found || !device_) {
            log_msg(label_, "DeckLink device index not found: " + std::to_string(device_index_));
            return false;
        }

        const char* model_name = nullptr;
        if (device_->GetModelName(&model_name) == S_OK && model_name) {
            label_ = "decklink[" + std::to_string(device_index_) + ":" + model_name + "]";
        } else {
            label_ = "decklink[" + std::to_string(device_index_) + "]";
        }

        if (device_->QueryInterface(IID_IDeckLinkOutput, reinterpret_cast<void**>(&output_)) != S_OK || !output_) {
            log_msg(label_, "IDeckLinkOutput unavailable");
            return false;
        }

        // Optional interfaces (best effort).
        device_->QueryInterface(IID_IDeckLinkKeyer, reinterpret_cast<void**>(&keyer_));
        device_->QueryInterface(IID_IDeckLinkProfileAttributes, reinterpret_cast<void**>(&attributes_));
        device_->QueryInterface(IID_IDeckLinkProfileManager, reinterpret_cast<void**>(&profile_manager_));

        auto bmd_mode = parse_display_mode(display_mode_name_);
        if (!bmd_mode.has_value()) {
            log_msg(label_, "unsupported display mode: " + display_mode_name_);
            return false;
        }

        if (output_->GetDisplayMode(*bmd_mode, &mode_) != S_OK || !mode_) {
            log_msg(label_, "GetDisplayMode failed for " + display_mode_name_);
            return false;
        }
        if (mode_->GetFrameRate(&frame_duration_, &time_scale_) != S_OK ||
            frame_duration_ <= 0 || time_scale_ <= 0) {
            log_msg(label_, "GetFrameRate failed");
            return false;
        }
        const BMDFieldDominance field = mode_->GetFieldDominance();
        interlaced_ = (field != bmdProgressiveFrame && field != bmdProgressiveSegmentedFrame);
        upper_field_first_ = (field == bmdUpperFieldFirst);

        row_bytes_ = width_ * 4;
        int sdk_row_bytes = 0;
        if (output_->RowBytesForPixelFormat(bmdFormat8BitBGRA, width_, &sdk_row_bytes) == S_OK &&
            sdk_row_bytes >= width_ * 4) {
            row_bytes_ = sdk_row_bytes;
        }

        BMDDisplayMode actual_mode = bmdModeUnknown;
        bool supported = false;
        if (output_->DoesSupportVideoMode(
                bmdVideoConnectionUnspecified,
                mode_->GetDisplayMode(),
                bmdFormat8BitBGRA,
                bmdNoVideoOutputConversion,
                bmdSupportedVideoModeDefault,
                &actual_mode,
                &supported) != S_OK || !supported) {
            log_msg(label_, "requested BGRA video mode is not supported");
            return false;
        }

        if (!ConfigureKeyer()) return false;

        if (profile_manager_) {
            if (profile_manager_->SetCallback(&profile_callback_) != S_OK) {
                log_msg(label_, "failed to register profile callback (continuing)");
            }
        }

        if (output_->SetScheduledFrameCompletionCallback(&output_callback_) != S_OK) {
            log_msg(label_, "SetScheduledFrameCompletionCallback failed");
            return false;
        }
        callback_installed_ = true;

        if (output_->EnableVideoOutput(mode_->GetDisplayMode(), bmdVideoOutputFlagDefault) != S_OK) {
            log_msg(label_, "EnableVideoOutput failed");
            return false;
        }
        video_enabled_ = true;

        next_display_time_ = 0;
        static constexpr int kPrerollFrames = 3;
        for (int i = 0; i < kPrerollFrames; ++i) {
            if (!ScheduleVideoBuffer(black_frame_, next_display_time_)) {
                log_msg(label_, "failed to schedule preroll frame");
                return false;
            }
            next_display_time_ += frame_duration_;
        }

        WaitForReferenceLock();

        if (output_->StartScheduledPlayback(0, time_scale_, 1.0) != S_OK) {
            log_msg(label_, "StartScheduledPlayback failed");
            return false;
        }
        playback_started_ = true;
        running_.store(true, std::memory_order_release);
        start_ok_ = true;

        log_msg(label_,
                "started mode=" + display_mode_name_ +
                " interlaced=" + std::string(interlaced_ ? "yes" : "no") +
                " keyer=" + KeyerLabel(keyer_mode_));
        return true;
    }

    void Stop() {
        const bool was_running = running_.exchange(false, std::memory_order_acq_rel);
        (void)was_running;

        if (profile_manager_) {
            profile_manager_->SetCallback(nullptr);
        }

        if (output_) {
            if (playback_started_) {
                output_->StopScheduledPlayback(0, nullptr, 0);
                playback_started_ = false;
            }
            if (video_enabled_) {
                output_->DisableVideoOutput();
                video_enabled_ = false;
            }
            if (callback_installed_) {
                output_->SetScheduledFrameCompletionCallback(nullptr);
                callback_installed_ = false;
            }
        }

        if (start_ok_) {
            char counters[320];
            std::snprintf(
                counters,
                sizeof(counters),
                "telemetry in=%llu scheduled=%llu late=%llu dropped=%llu flushed=%llu overwrite=%llu",
                static_cast<unsigned long long>(frames_in_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(scheduled_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(late_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(dropped_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(flushed_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(frames_overwritten_.load(std::memory_order_relaxed)));
            log_msg(label_, counters);
        }

        {
            std::lock_guard<std::mutex> lock(queue_mu_);
            frame_queue_.clear();
        }
        pending_field_.reset();
        start_ok_ = false;

        release_com(mode_);
        release_com(profile_manager_);
        release_com(attributes_);
        release_com(keyer_);
        release_com(output_);
        release_com(device_);
        if (decklink_lib_) {
            dlclose(decklink_lib_);
            decklink_lib_ = nullptr;
            create_iterator_ = nullptr;
        }
    }

    void OnFrame(const Frame& frame) {
        if (!running_.load(std::memory_order_acquire)) return;
        if (!frame.bgra || frame.width != width_ || frame.height != height_) return;

        BufferedFrame packed;
        packed.seq = frame.seq;
        packed.bytes.resize(frame_bytes_);
        std::memcpy(packed.bytes.data(), frame.bgra, frame_bytes_);

        {
            std::lock_guard<std::mutex> lock(queue_mu_);
            frames_in_.fetch_add(1, std::memory_order_relaxed);
            if (frame_queue_.size() >= kMaxQueuedFrames) {
                frame_queue_.pop_front();
                frames_overwritten_.fetch_add(1, std::memory_order_relaxed);
            }
            frame_queue_.push_back(std::move(packed));
        }
    }

    int PollExitCode() const {
        return requested_exit_code_.load(std::memory_order_acquire);
    }

    HRESULT OnScheduledFrameCompleted(
        IDeckLinkVideoFrame* /*completed_frame*/,
        BMDOutputFrameCompletionResult result) {
        if (!running_.load(std::memory_order_acquire)) return S_OK;

        completed_.fetch_add(1, std::memory_order_relaxed);

        if (result == bmdOutputFrameDisplayedLate) {
            late_.fetch_add(1, std::memory_order_relaxed);
            // CasparCG parity: skip-ahead when the card reports a late frame.
            next_display_time_ += frame_duration_;
        } else if (result == bmdOutputFrameDropped) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
        } else if (result == bmdOutputFrameFlushed) {
            flushed_.fetch_add(1, std::memory_order_relaxed);
        }

        BufferedFrame frame_a = TakeFrameOrLast();
        BufferedFrame frame_b;
        if (interlaced_) {
            frame_b = TakeFrameOrLast();
        }

        std::vector<uint8_t> output_frame;
        if (interlaced_) {
            output_frame = WeaveFields(frame_a.bytes, frame_b.bytes);
            if (!frame_b.bytes.empty()) last_frame_ = frame_b.bytes;
        } else {
            output_frame = std::move(frame_a.bytes);
            if (!output_frame.empty()) last_frame_ = output_frame;
        }
        if (output_frame.empty()) output_frame = black_frame_;

        if (!ScheduleVideoBuffer(output_frame, next_display_time_)) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return E_FAIL;
        }
        next_display_time_ += frame_duration_;
        return S_OK;
    }

    void RequestRestart(int code) {
        int expected = 0;
        requested_exit_code_.compare_exchange_strong(
            expected, code, std::memory_order_acq_rel, std::memory_order_relaxed);
    }

    bool ConfigureKeyer() {
        if (keyer_mode_ == KeyerMode::FillOnly) {
            if (keyer_) keyer_->Disable();
            return true;
        }

        if (!keyer_) {
            log_msg(label_, "keyer interface not available on this device");
            return false;
        }

        BMDDisplayMode actual_mode = bmdModeUnknown;
        bool keying_supported = false;
        if (output_->DoesSupportVideoMode(
                bmdVideoConnectionUnspecified,
                mode_->GetDisplayMode(),
                bmdFormat8BitBGRA,
                bmdNoVideoOutputConversion,
                bmdSupportedVideoModeKeying,
                &actual_mode,
                &keying_supported) == S_OK &&
            !keying_supported) {
            log_msg(label_, "selected mode does not support keying");
            return false;
        }

        if (keyer_mode_ == KeyerMode::Internal) {
            if (attributes_) {
                bool supported = true;
                if (attributes_->GetFlag(BMDDeckLinkSupportsInternalKeying, &supported) == S_OK && !supported) {
                    log_msg(label_, "internal keying is not supported");
                    return false;
                }
            }
            if (keyer_->Enable(false) != S_OK || keyer_->SetLevel(255) != S_OK) {
                log_msg(label_, "failed to enable internal keyer");
                return false;
            }
            return true;
        }

        if (keyer_mode_ == KeyerMode::External) {
            if (attributes_) {
                bool supported = true;
                if (attributes_->GetFlag(BMDDeckLinkSupportsExternalKeying, &supported) == S_OK && !supported) {
                    log_msg(label_, "external keying is not supported");
                    return false;
                }
            }
            if (keyer_->Enable(true) != S_OK || keyer_->SetLevel(255) != S_OK) {
                log_msg(label_, "failed to enable external keyer");
                return false;
            }
            return true;
        }

        return true;
    }

    bool LoadDeckLinkRuntime() {
        if (decklink_lib_ && create_iterator_) return true;

        decklink_lib_ = dlopen("libDeckLinkAPI.so", RTLD_NOW | RTLD_LOCAL);
        if (!decklink_lib_) {
            log_msg(label_, "dlopen(libDeckLinkAPI.so) failed");
            return false;
        }

        create_iterator_ = reinterpret_cast<CreateIteratorFn>(
            dlsym(decklink_lib_, "CreateDeckLinkIteratorInstance"));
        if (!create_iterator_) {
            log_msg(label_, "dlsym(CreateDeckLinkIteratorInstance) failed");
            dlclose(decklink_lib_);
            decklink_lib_ = nullptr;
            return false;
        }
        return true;
    }

    void WaitForReferenceLock() {
        // No hard failure when lock is unavailable: development hosts may not
        // have genlock connected. We keep this as telemetry-only like CasparCG.
        static constexpr int kAttempts = 20;
        for (int i = 0; i < kAttempts; ++i) {
            BMDReferenceStatus status = bmdReferenceUnlocked;
            if (output_->GetReferenceStatus(&status) != S_OK) {
                log_msg(label_, "GetReferenceStatus failed");
                return;
            }
            if (status & bmdReferenceNotSupportedByHardware) {
                log_msg(label_, "reference status not supported by hardware");
                return;
            }
            if (status & bmdReferenceLocked) {
                log_msg(label_, "reference signal locked");
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        log_msg(label_, "reference signal lock timeout (continuing)");
    }

    BufferedFrame TakeFrameOrLast() {
        std::lock_guard<std::mutex> lock(queue_mu_);
        if (!frame_queue_.empty()) {
            BufferedFrame out = std::move(frame_queue_.front());
            frame_queue_.pop_front();
            if (!out.bytes.empty()) return out;
        }
        BufferedFrame fallback;
        fallback.bytes = last_frame_;
        return fallback;
    }

    std::vector<uint8_t> WeaveFields(const std::vector<uint8_t>& field_a,
                                     const std::vector<uint8_t>& field_b) const {
        if (field_a.size() != frame_bytes_ || field_b.size() != frame_bytes_) {
            return black_frame_;
        }

        std::vector<uint8_t> out(frame_bytes_);
        const size_t line_bytes = static_cast<size_t>(width_) * 4;
        for (int y = 0; y < height_; ++y) {
            const bool use_first =
                upper_field_first_ ? ((y % 2) == 0) : ((y % 2) == 1);
            const uint8_t* src = use_first ? field_a.data() : field_b.data();
            std::memcpy(
                out.data() + static_cast<size_t>(y) * line_bytes,
                src + static_cast<size_t>(y) * line_bytes,
                line_bytes);
        }
        return out;
    }

    bool ScheduleVideoBuffer(const std::vector<uint8_t>& bgra, BMDTimeValue display_time) {
        if (!output_ || bgra.size() != frame_bytes_) return false;

        const size_t src_row_bytes = static_cast<size_t>(width_) * 4;
        std::vector<uint8_t> packed(static_cast<size_t>(row_bytes_) * static_cast<size_t>(height_), 0);
        if (row_bytes_ == static_cast<int>(src_row_bytes)) {
            std::memcpy(packed.data(), bgra.data(), frame_bytes_);
        } else {
            for (int y = 0; y < height_; ++y) {
                std::memcpy(
                    packed.data() + static_cast<size_t>(y) * static_cast<size_t>(row_bytes_),
                    bgra.data() + static_cast<size_t>(y) * src_row_bytes,
                    src_row_bytes);
            }
        }

        auto* frame = new OwnedDecklinkFrame(width_, height_, row_bytes_, std::move(packed));
        const HRESULT hr = output_->ScheduleVideoFrame(
            frame, display_time, frame_duration_, time_scale_);
        frame->Release();

        if (hr != S_OK) return false;
        scheduled_.fetch_add(1, std::memory_order_relaxed);
        return true;
    }

    static constexpr size_t kMaxQueuedFrames = 8;

    int device_index_ = -1;
    std::string display_mode_name_;
    KeyerMode keyer_mode_ = KeyerMode::External;
    std::string label_ = "decklink";

    int width_ = 0;
    int height_ = 0;
    int fps_ = 0;
    int row_bytes_ = 0;
    size_t frame_bytes_ = 0;
    bool interlaced_ = false;
    bool upper_field_first_ = true;

    IDeckLink* device_ = nullptr;
    IDeckLinkOutput* output_ = nullptr;
    IDeckLinkKeyer* keyer_ = nullptr;
    IDeckLinkProfileAttributes* attributes_ = nullptr;
    IDeckLinkProfileManager* profile_manager_ = nullptr;
    IDeckLinkDisplayMode* mode_ = nullptr;
    using CreateIteratorFn = IDeckLinkIterator* (*)(void);
    void* decklink_lib_ = nullptr;
    CreateIteratorFn create_iterator_ = nullptr;

    BMDTimeValue frame_duration_ = 0;
    BMDTimeScale time_scale_ = 0;
    BMDTimeValue next_display_time_ = 0;

    std::mutex queue_mu_;
    std::deque<BufferedFrame> frame_queue_;
    std::vector<uint8_t> last_frame_;
    std::vector<uint8_t> black_frame_;
    std::optional<BufferedFrame> pending_field_;

    std::atomic<bool> running_{false};
    std::atomic<int> requested_exit_code_{0};
    bool callback_installed_ = false;
    bool video_enabled_ = false;
    bool playback_started_ = false;
    bool start_ok_ = false;

    std::atomic<uint64_t> completed_{0};
    std::atomic<uint64_t> late_{0};
    std::atomic<uint64_t> dropped_{0};
    std::atomic<uint64_t> flushed_{0};
    std::atomic<uint64_t> scheduled_{0};
    std::atomic<uint64_t> frames_in_{0};
    std::atomic<uint64_t> frames_overwritten_{0};

    OutputCallback output_callback_{this};
    ProfileCallback profile_callback_{this};
};

DecklinkConsumer::DecklinkConsumer(int device_index, std::string display_mode, KeyerMode keyer_mode)
    : impl_(std::make_unique<Impl>(device_index, std::move(display_mode), keyer_mode)) {}

DecklinkConsumer::~DecklinkConsumer() = default;

bool DecklinkConsumer::Start(int width, int height, int fps) {
    return impl_ ? impl_->Start(width, height, fps) : false;
}

void DecklinkConsumer::OnFrame(const Frame& frame) {
    if (impl_) impl_->OnFrame(frame);
}

void DecklinkConsumer::Stop() {
    if (impl_) impl_->Stop();
}

const char* DecklinkConsumer::Label() const {
    return impl_ ? impl_->label_.c_str() : "decklink";
}

int DecklinkConsumer::PollExitCode() const {
    return impl_ ? impl_->PollExitCode() : 0;
}

}  // namespace bg
