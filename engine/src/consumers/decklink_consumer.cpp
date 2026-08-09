#include "consumers/decklink_consumer.h"

#include "aligned_buffer.h"
#include "decklink_event_log.h"
#include "decklink_provenance.h"
#include "frame_log.h"
#include "simd_copy.h"

#include "DeckLinkAPI.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
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
    AlignedBuffer bytes;
    uint64_t seq = 0;
};

class OwnedDecklinkFrame final : public IDeckLinkVideoFrame, public IDeckLinkVideoBuffer {
  public:
    OwnedDecklinkFrame(int width, int height, int row_bytes, AlignedBuffer&& data,
                       uint64_t schedule_seq)
        : width_(width), height_(height), row_bytes_(row_bytes), data_(std::move(data)),
          schedule_seq_(schedule_seq) {}

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

    // Buffer recycling: the completion callback steals the displayed frame's
    // storage so the next ScheduleVideoBuffer() reuses it instead of a fresh
    // 8MB allocation every 20-40ms (allocation jitter on the playback path).
    AlignedBuffer TakeBuffer() { return std::move(data_); }
    uint64_t schedule_seq() const { return schedule_seq_; }
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
    AlignedBuffer data_;
    uint64_t schedule_seq_ = 0;
};

}  // namespace

struct DecklinkConsumer::Impl {
    explicit Impl(int device_index, std::string display_mode, KeyerMode keyer_mode,
                  std::string completion_log_path)
        : device_index_(device_index),
          display_mode_name_(std::move(display_mode)),
          keyer_mode_(keyer_mode),
          event_log_(std::make_unique<DecklinkEventLog>(completion_log_path)) {}

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
        black_frame_.Reset(frame_bytes_);
        black_frame_.ZeroFill();
        // Start with black fields so the first starved completions output black
        // instead of garbage.
        field_a_.Reset(frame_bytes_);
        field_a_.ZeroFill();
        field_b_.Reset(frame_bytes_);
        field_b_.ZeroFill();
        single_alias_ = false;

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

        // Phase 11.5: low-latency scheduled playback (CasparCG parity —
        // modules/decklink/consumer/decklink_consumer.cpp SetFlag call).
        // Reduces the card's internal output buffering; preroll depth below
        // is chosen to match (CasparCG's buffer_depth() formula: base 3 +
        // 1 if NOT low-latency + 1 if embedded audio — we have no embedded
        // audio, so 3 with the flag applied, 4 without).
        IDeckLinkConfiguration* config = nullptr;
        if (device_->QueryInterface(IID_IDeckLinkConfiguration, reinterpret_cast<void**>(&config)) == S_OK &&
            config) {
            const HRESULT hr = config->SetFlag(bmdDeckLinkConfigLowLatencyVideoOutput, true);
            low_latency_applied_ = (hr == S_OK);
            if (hr != S_OK) {
                log_msg(label_, "bmdDeckLinkConfigLowLatencyVideoOutput unsupported (continuing)");
            }
            config->Release();
        }

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
        // CasparCG buffer_depth(): base 3 + 1 if not low-latency + 1 if
        // embedded audio (we carry no audio, so that term is always 0).
        static constexpr int kBaseBufferDepth = 3;
        const int preroll_frames = kBaseBufferDepth + (low_latency_applied_ ? 0 : 1);
        for (int i = 0; i < preroll_frames; ++i) {
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
                " keyer=" + KeyerLabel(keyer_mode_) +
                " low_latency=" + std::string(low_latency_applied_ ? "yes" : "no") +
                " preroll=" + std::to_string(preroll_frames));
        return true;
    }

    void Stop() {
        const bool was_running = running_.exchange(false, std::memory_order_acq_rel);
        (void)was_running;
        // Wake a blocked WaitForTick() so main.cpp's decklink-driven loop
        // notices shutdown instead of waiting out its fallback timeout.
        tick_cv_.notify_all();

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
            char counters[360];
            std::snprintf(
                counters,
                sizeof(counters),
                "telemetry in=%llu scheduled=%llu late=%llu dropped=%llu flushed=%llu "
                "overwrite=%llu starved=%llu pairs=%llu singles=%llu",
                static_cast<unsigned long long>(frames_in_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(scheduled_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(late_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(dropped_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(flushed_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(frames_overwritten_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(starved_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(pairs_.load(std::memory_order_relaxed)),
                static_cast<unsigned long long>(singles_.load(std::memory_order_relaxed)));
            log_msg(label_, counters);
        }

        {
            std::lock_guard<std::mutex> lock(queue_mu_);
            frame_queue_.clear();
        }
        {
            std::lock_guard<std::mutex> lock(recycle_mu_);
            recycle_pool_.clear();
        }
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

        const auto t_total = std::chrono::steady_clock::now();

        // Phase 11.3: pull a recycled 64B-aligned buffer instead of letting a
        // fresh BufferedFrame's default-constructed (empty) AlignedBuffer
        // force a new ~8MB aligned_alloc every call — that allocation (fresh
        // mmap + page faults above glibc's mmap_threshold) dominated the
        // copy_us telemetry far more than the memcpy bandwidth itself
        // (docs/phase11-baseline.md §4).
        BufferedFrame packed;
        packed.seq = frame.seq;
        const auto t_pool = std::chrono::steady_clock::now();
        packed.bytes = GetInputBuffer();
        RecordStageTime(input_pool_us_sum_, input_pool_us_max_, input_pool_us_count_, t_pool);
        const auto t_memcpy = std::chrono::steady_clock::now();
        packed.bytes.CopyFrom(frame.bgra, frame_bytes_);
        RecordStageTime(onframe_memcpy_us_sum_, onframe_memcpy_us_max_,
                        onframe_memcpy_us_count_, t_memcpy);
        onframe_copy_bytes_.fetch_add(frame_bytes_, std::memory_order_relaxed);

        BufferedFrame overwritten;
        bool have_overwritten = false;
        {
            std::lock_guard<std::mutex> lock(queue_mu_);
            frames_in_.fetch_add(1, std::memory_order_relaxed);
            if (frame_queue_.size() >= kMaxQueuedFrames) {
                overwritten = std::move(frame_queue_.front());
                frame_queue_.pop_front();
                have_overwritten = true;
                frames_overwritten_.fetch_add(1, std::memory_order_relaxed);
            }
            frame_queue_.push_back(std::move(packed));
        }
        if (have_overwritten) RecycleInputBuffer(std::move(overwritten.bytes));

        RecordStageTime(copy_us_sum_, copy_us_max_, copy_us_count_, t_total);
    }

    void RecordRingCopy(uint64_t us, size_t bytes) {
        ring_copy_us_sum_.fetch_add(us, std::memory_order_relaxed);
        ring_copy_count_.fetch_add(1, std::memory_order_relaxed);
        ring_copy_bytes_.fetch_add(bytes, std::memory_order_relaxed);
        uint64_t prev = ring_copy_us_max_.load(std::memory_order_relaxed);
        while (us > prev &&
               !ring_copy_us_max_.compare_exchange_weak(
                   prev, us, std::memory_order_relaxed)) {
        }
    }

    void RecordDirectDelivery(size_t bytes) {
        direct_deliveries_.fetch_add(1, std::memory_order_relaxed);
        direct_delivery_bytes_.fetch_add(bytes, std::memory_order_relaxed);
    }

    int PollExitCode() const {
        return requested_exit_code_.load(std::memory_order_acquire);
    }

    HRESULT OnScheduledFrameCompleted(
        IDeckLinkVideoFrame* completed_frame,
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

        // Recycle the displayed frame's storage: every frame we schedule is our
        // OwnedDecklinkFrame, so steal its buffer instead of allocating a fresh
        // ~8MB block per output frame (malloc jitter on the playback path).
        if (completed_frame) {
            auto* owned = static_cast<OwnedDecklinkFrame*>(completed_frame);
            if (event_log_ && event_log_->enabled()) {
                const FrameLogClockSample clocks = CaptureFrameLogClocks();
                event_log_->TryPush({
                    .type = DecklinkEventType::Completion,
                    .schedule_seq = owned->schedule_seq(),
                    .unix_us = clocks.unix_us,
                    .mono_us = clocks.mono_us,
                    .result = static_cast<int32_t>(result),
                });
            }
            RecycleBuffer(owned->TakeBuffer());
        }

        // Pull up to the fields needed for one output frame. Never mix a fresh
        // frame with a stale one: weaving new field A with old field B inverts
        // time between fields and shows as tearing/flicker on air (Phase 10
        // root cause). Starvation policy instead:
        //   2 fresh -> normal weave (A older, B newer: correct field order)
        //   1 fresh -> duplicate it into both fields (progressive-look, no comb)
        //   0 fresh -> repeat the previous pair verbatim (steady frame repeat)
        size_t fresh = 0;
        BufferedFrame f0;
        BufferedFrame f1;
        {
            std::lock_guard<std::mutex> lock(queue_mu_);
            const size_t queue_depth_before = frame_queue_.size();
            if (!frame_queue_.empty()) {
                f0 = std::move(frame_queue_.front());
                frame_queue_.pop_front();
                fresh = 1;
                if (interlaced_ && !frame_queue_.empty()) {
                    f1 = std::move(frame_queue_.front());
                    frame_queue_.pop_front();
                    fresh = 2;
                }
            }
            last_queue_depth_before_ = queue_depth_before;
        }

        const WeaveProvenanceDecision provenance = DecideWeaveProvenance(
            fresh, f0.seq, f1.seq, {field_a_seq_, field_b_seq_});

        if (interlaced_) {
            if (fresh == 2 && f0.bytes.size() == frame_bytes_ && f1.bytes.size() == frame_bytes_) {
                RecycleInputBuffer(std::move(field_a_));
                RecycleInputBuffer(std::move(field_b_));
                field_a_ = std::move(f0.bytes);
                field_b_ = std::move(f1.bytes);
                field_a_seq_ = provenance.woven.field_a_seq;
                field_b_seq_ = provenance.woven.field_b_seq;
                single_alias_ = false;
                pairs_.fetch_add(1, std::memory_order_relaxed);
            } else if (fresh >= 1 && f0.bytes.size() == frame_bytes_) {
                RecycleInputBuffer(std::move(field_a_));
                RecycleInputBuffer(std::move(field_b_));
                // RecycleInputBuffer intentionally drops a buffer when the
                // pool is full. Explicitly clear B either way: in alias mode
                // A is the sole owner and retaining a rejected B would strand
                // an unnecessary 8MB allocation until the next pair.
                field_b_ = AlignedBuffer{};
                // A single fresh progressive bitmap must feed both interlaced
                // fields. Keep one owner in field_a_ and let weave read it for
                // A and B instead of cloning another 8MB input buffer.
                field_a_ = std::move(f0.bytes);
                field_a_seq_ = provenance.woven.field_a_seq;
                field_b_seq_ = provenance.woven.field_b_seq;
                single_alias_ = true;
                alias_singles_.fetch_add(1, std::memory_order_relaxed);
                singles_.fetch_add(1, std::memory_order_relaxed);
            } else {
                starved_.fetch_add(1, std::memory_order_relaxed);
                // keep previous field_a_/field_b_ -> exact repeat
            }
        } else {
            single_alias_ = false;
            if (fresh >= 1 && f0.bytes.size() == frame_bytes_) {
                RecycleInputBuffer(std::move(field_a_));
                field_a_ = std::move(f0.bytes);
            } else {
                starved_.fetch_add(1, std::memory_order_relaxed);
            }
        }

        const uint64_t schedule_seq = ++next_schedule_seq_;
        const BMDTimeValue display_time = next_display_time_;
        if (!ScheduleWovenOutput(display_time, schedule_seq)) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return E_FAIL;
        }
        if (event_log_ && event_log_->enabled()) {
            const FrameLogClockSample clocks = CaptureFrameLogClocks();
            event_log_->TryPush({
                .type = DecklinkEventType::Schedule,
                .schedule_seq = schedule_seq,
                .unix_us = clocks.unix_us,
                .mono_us = clocks.mono_us,
                .display_time = display_time,
                .time_scale = time_scale_,
                .queue_depth_before = static_cast<uint32_t>(last_queue_depth_before_),
                .fresh_count = static_cast<uint32_t>(fresh),
                .popped = {.field_a_seq = f0.seq, .field_b_seq = f1.seq},
                .woven = provenance.woven,
                .weave_mode = provenance.mode,
            });
        }
        next_display_time_ += frame_duration_;

        // Phase 11.2: wake the render pump for the fields this cycle just
        // consumed, so it renders the *next* ones ahead of the *next*
        // callback (~1 output frame away) instead of free-running on its own
        // timer. This is what makes DeckLink the single clock end-to-end.
        RequestTicks(interlaced_ ? 2 : 1);

        MaybeLogTelemetry();
        return S_OK;
    }

    // --- Phase 11.2: external clock (see consumer.h) -----------------------
    void RequestTicks(int n) {
        {
            std::lock_guard<std::mutex> lock(tick_mu_);
            pending_ticks_ += n;
        }
        tick_cv_.notify_one();
    }

    int WaitForTick(int64_t timeout_us) {
        std::unique_lock<std::mutex> lock(tick_mu_);
        if (pending_ticks_ <= 0) {
            tick_cv_.wait_for(lock, std::chrono::microseconds(timeout_us), [&] {
                return pending_ticks_ > 0 || !running_.load(std::memory_order_acquire);
            });
        }
        const int n = pending_ticks_;
        pending_ticks_ = 0;
        return n;
    }

    std::mutex tick_mu_;
    std::condition_variable tick_cv_;
    int pending_ticks_ = 0;

    // Periodic (5s) consumer-side telemetry, logged from the DeckLink completion
    // callback thread. Deltas describe the last window; totals are cumulative.
    // in_fps < channel fps means the render plane starves the consumer and the
    // output repeats/mixes fields — the exact signal we need for diagnosing
    // torn output (Phase 10).
    void MaybeLogTelemetry() {
        const auto now = std::chrono::steady_clock::now();
        if (telemetry_last_.time_since_epoch().count() == 0) {
            telemetry_last_ = now;
            return;
        }
        const double sec =
            std::chrono::duration_cast<std::chrono::duration<double>>(now - telemetry_last_).count();
        if (sec < 5.0) return;
        telemetry_last_ = now;

        const uint64_t in        = frames_in_.load(std::memory_order_relaxed);
        const uint64_t completed = completed_.load(std::memory_order_relaxed);
        const uint64_t late      = late_.load(std::memory_order_relaxed);
        const uint64_t dropped   = dropped_.load(std::memory_order_relaxed);
        const uint64_t flushed   = flushed_.load(std::memory_order_relaxed);
        const uint64_t overwr    = frames_overwritten_.load(std::memory_order_relaxed);
        const uint64_t starved   = starved_.load(std::memory_order_relaxed);
        const uint64_t pairs     = pairs_.load(std::memory_order_relaxed);
        const uint64_t singles   = singles_.load(std::memory_order_relaxed);
        const uint64_t aliases   = alias_singles_.load(std::memory_order_relaxed);

        size_t queue_depth = 0;
        {
            std::lock_guard<std::mutex> lock(queue_mu_);
            queue_depth = frame_queue_.size();
        }

        const char* ref = "n/a";
        BMDReferenceStatus status = bmdReferenceUnlocked;
        if (output_ && output_->GetReferenceStatus(&status) == S_OK) {
            if (status & bmdReferenceNotSupportedByHardware) ref = "unsupported";
            else if (status & bmdReferenceLocked)            ref = "locked";
            else                                             ref = "UNLOCKED";
        }

        // Per-output-frame time budget in microseconds (e.g. 40000us at 25Hz
        // for HD1080i50). Stage % is avg-stage-us / budget_us, so >100% on any
        // one stage means that stage alone would miss the output cadence.
        const double budget_us = (time_scale_ > 0)
            ? static_cast<double>(frame_duration_) * 1'000'000.0 / static_cast<double>(time_scale_)
            : 0.0;

        const uint64_t copy_sum = copy_us_sum_.exchange(0, std::memory_order_relaxed);
        const uint64_t copy_max = copy_us_max_.exchange(0, std::memory_order_relaxed);
        const uint64_t copy_cnt = copy_us_count_.exchange(0, std::memory_order_relaxed);
        const uint64_t weave_sum = weave_us_sum_.exchange(0, std::memory_order_relaxed);
        const uint64_t weave_max = weave_us_max_.exchange(0, std::memory_order_relaxed);
        const uint64_t weave_cnt = weave_us_count_.exchange(0, std::memory_order_relaxed);
        const uint64_t sched_sum = schedule_us_sum_.exchange(0, std::memory_order_relaxed);
        const uint64_t sched_max = schedule_us_max_.exchange(0, std::memory_order_relaxed);
        const uint64_t sched_cnt = schedule_us_count_.exchange(0, std::memory_order_relaxed);
        const uint64_t ring_sum = ring_copy_us_sum_.exchange(0, std::memory_order_relaxed);
        const uint64_t ring_max = ring_copy_us_max_.exchange(0, std::memory_order_relaxed);
        const uint64_t ring_cnt = ring_copy_count_.exchange(0, std::memory_order_relaxed);
        const uint64_t ring_bytes = ring_copy_bytes_.exchange(0, std::memory_order_relaxed);
        const uint64_t input_pool_sum =
            input_pool_us_sum_.exchange(0, std::memory_order_relaxed);
        const uint64_t input_pool_max =
            input_pool_us_max_.exchange(0, std::memory_order_relaxed);
        const uint64_t input_pool_cnt =
            input_pool_us_count_.exchange(0, std::memory_order_relaxed);
        const uint64_t onframe_sum =
            onframe_memcpy_us_sum_.exchange(0, std::memory_order_relaxed);
        const uint64_t onframe_max =
            onframe_memcpy_us_max_.exchange(0, std::memory_order_relaxed);
        const uint64_t onframe_cnt =
            onframe_memcpy_us_count_.exchange(0, std::memory_order_relaxed);
        const uint64_t onframe_bytes =
            onframe_copy_bytes_.exchange(0, std::memory_order_relaxed);
        const uint64_t clone_sum =
            singles_clone_us_sum_.exchange(0, std::memory_order_relaxed);
        const uint64_t clone_max =
            singles_clone_us_max_.exchange(0, std::memory_order_relaxed);
        const uint64_t clone_cnt =
            singles_clone_us_count_.exchange(0, std::memory_order_relaxed);
        const uint64_t clone_bytes =
            singles_clone_bytes_.exchange(0, std::memory_order_relaxed);
        const uint64_t weave_bytes =
            weave_copy_bytes_.exchange(0, std::memory_order_relaxed);
        const uint64_t input_hits =
            input_pool_hits_.exchange(0, std::memory_order_relaxed);
        const uint64_t input_misses =
            input_pool_misses_.exchange(0, std::memory_order_relaxed);
        const uint64_t output_hits =
            output_pool_hits_.exchange(0, std::memory_order_relaxed);
        const uint64_t output_misses =
            output_pool_misses_.exchange(0, std::memory_order_relaxed);
        const uint64_t direct_deliveries =
            direct_deliveries_.exchange(0, std::memory_order_relaxed);
        const uint64_t direct_bytes =
            direct_delivery_bytes_.exchange(0, std::memory_order_relaxed);

        const double copy_avg  = copy_cnt  ? static_cast<double>(copy_sum)  / copy_cnt  : 0.0;
        const double weave_avg = weave_cnt ? static_cast<double>(weave_sum) / weave_cnt : 0.0;
        const double sched_avg = sched_cnt ? static_cast<double>(sched_sum) / sched_cnt : 0.0;
        const double ring_avg = ring_cnt ? static_cast<double>(ring_sum) / ring_cnt : 0.0;
        const double input_pool_avg =
            input_pool_cnt ? static_cast<double>(input_pool_sum) / input_pool_cnt : 0.0;
        const double onframe_avg =
            onframe_cnt ? static_cast<double>(onframe_sum) / onframe_cnt : 0.0;
        const double clone_avg =
            clone_cnt ? static_cast<double>(clone_sum) / clone_cnt : 0.0;

        char buf[480];
        std::snprintf(
            buf, sizeof(buf),
            "telemetry5s in_fps=%.1f out_fps=%.1f queue=%zu "
            "d_pairs=%llu d_singles=%llu d_starved=%llu "
            "d_late=%llu d_dropped=%llu d_flushed=%llu d_overwritten=%llu "
            "ref=%s | totals in=%llu completed=%llu pairs=%llu singles=%llu starved=%llu "
            "late=%llu dropped=%llu flushed=%llu",
            static_cast<double>(in - prev_in_) / sec,
            static_cast<double>(completed - prev_completed_) / sec,
            queue_depth,
            static_cast<unsigned long long>(pairs - prev_pairs_),
            static_cast<unsigned long long>(singles - prev_singles_),
            static_cast<unsigned long long>(starved - prev_starved_),
            static_cast<unsigned long long>(late - prev_late_),
            static_cast<unsigned long long>(dropped - prev_dropped_),
            static_cast<unsigned long long>(flushed - prev_flushed_),
            static_cast<unsigned long long>(overwr - prev_overwritten_),
            ref,
            static_cast<unsigned long long>(in),
            static_cast<unsigned long long>(completed),
            static_cast<unsigned long long>(pairs),
            static_cast<unsigned long long>(singles),
            static_cast<unsigned long long>(starved),
            static_cast<unsigned long long>(late),
            static_cast<unsigned long long>(dropped),
            static_cast<unsigned long long>(flushed));
        log_msg(label_, buf);

        char stage_buf[360];
        std::snprintf(
            stage_buf, sizeof(stage_buf),
            "stages5s budget_us=%.0f copy_avg_us=%.1f copy_max_us=%llu copy_pct=%.1f "
            "weave_avg_us=%.1f weave_max_us=%llu weave_pct=%.1f "
            "schedule_avg_us=%.1f schedule_max_us=%llu schedule_pct=%.1f",
            budget_us,
            copy_avg, static_cast<unsigned long long>(copy_max),
            budget_us > 0.0 ? 100.0 * copy_avg / budget_us : 0.0,
            weave_avg, static_cast<unsigned long long>(weave_max),
            budget_us > 0.0 ? 100.0 * weave_avg / budget_us : 0.0,
            sched_avg, static_cast<unsigned long long>(sched_max),
            budget_us > 0.0 ? 100.0 * sched_avg / budget_us : 0.0);
        log_msg(label_, stage_buf);

        char memory_buf[640];
        std::snprintf(
            memory_buf, sizeof(memory_buf),
            "memory5s ring_avg_us=%.1f ring_max_us=%llu ring_count=%llu ring_bytes=%llu "
            "input_pool_avg_us=%.1f input_pool_max_us=%llu input_pool_count=%llu "
            "onframe_memcpy_avg_us=%.1f onframe_memcpy_max_us=%llu "
            "onframe_memcpy_count=%llu onframe_bytes=%llu "
            "singles_clone_avg_us=%.1f singles_clone_max_us=%llu "
            "singles_clone_count=%llu singles_clone_bytes=%llu "
            "weave_bytes=%llu alias_singles=%llu direct_deliveries=%llu direct_bytes=%llu "
            "input_pool_hit=%llu input_pool_miss=%llu "
            "output_pool_hit=%llu output_pool_miss=%llu",
            ring_avg, static_cast<unsigned long long>(ring_max),
            static_cast<unsigned long long>(ring_cnt),
            static_cast<unsigned long long>(ring_bytes),
            input_pool_avg, static_cast<unsigned long long>(input_pool_max),
            static_cast<unsigned long long>(input_pool_cnt),
            onframe_avg, static_cast<unsigned long long>(onframe_max),
            static_cast<unsigned long long>(onframe_cnt),
            static_cast<unsigned long long>(onframe_bytes),
            clone_avg, static_cast<unsigned long long>(clone_max),
            static_cast<unsigned long long>(clone_cnt),
            static_cast<unsigned long long>(clone_bytes),
            static_cast<unsigned long long>(weave_bytes),
            static_cast<unsigned long long>(aliases - prev_alias_singles_),
            static_cast<unsigned long long>(direct_deliveries),
            static_cast<unsigned long long>(direct_bytes),
            static_cast<unsigned long long>(input_hits),
            static_cast<unsigned long long>(input_misses),
            static_cast<unsigned long long>(output_hits),
            static_cast<unsigned long long>(output_misses));
        log_msg(label_, memory_buf);

        prev_in_          = in;
        prev_completed_   = completed;
        prev_late_        = late;
        prev_dropped_     = dropped;
        prev_flushed_     = flushed;
        prev_overwritten_ = overwr;
        prev_starved_     = starved;
        prev_pairs_       = pairs;
        prev_singles_     = singles;
        prev_alias_singles_ = aliases;
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

        static constexpr const char* kIteratorSymbols[] = {
            "CreateDeckLinkIteratorInstance",
            "CreateDeckLinkIteratorInstance_0004",
            "CreateDeckLinkIteratorInstance_0003",
            "CreateDeckLinkIteratorInstance_0002",
        };
        for (const char* symbol : kIteratorSymbols) {
            create_iterator_ = reinterpret_cast<CreateIteratorFn>(dlsym(decklink_lib_, symbol));
            if (create_iterator_) break;
        }
        if (!create_iterator_) {
            log_msg(label_, "dlsym(CreateDeckLinkIteratorInstance*) failed");
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

    void RecycleBuffer(AlignedBuffer&& buf) {
        const size_t output_bytes = static_cast<size_t>(row_bytes_) * static_cast<size_t>(height_);
        if (buf.size() != output_bytes) return;
        std::lock_guard<std::mutex> lock(recycle_mu_);
        if (recycle_pool_.size() < kMaxRecycledBuffers) {
            recycle_pool_.push_back(std::move(buf));
        }
    }

    AlignedBuffer GetOutputBuffer() {
        const size_t output_bytes = static_cast<size_t>(row_bytes_) * static_cast<size_t>(height_);
        {
            std::lock_guard<std::mutex> lock(recycle_mu_);
            if (!recycle_pool_.empty()) {
                AlignedBuffer buf = std::move(recycle_pool_.back());
                recycle_pool_.pop_back();
                output_pool_hits_.fetch_add(1, std::memory_order_relaxed);
                return buf;
            }
        }
        output_pool_misses_.fetch_add(1, std::memory_order_relaxed);
        AlignedBuffer buf(output_bytes);
        // Zero once on first allocation: row_bytes_ can exceed width_*4 (SDK
        // stride padding) and the weave loop below only writes the visible
        // width_*4 bytes per line, leaving stride padding untouched. Padding
        // is never displayed, but zero-filling keeps a freshly grown pool
        // deterministic instead of exposing uninitialized heap bytes.
        buf.ZeroFill();
        return buf;
    }

    // Phase 11.3: input-side pool, mirroring the output-side recycle_pool_
    // above. field_a_/field_b_ and the OnFrame() queue buffers are all
    // frame_bytes_-sized (width*height*4, no SDK row padding) so they share
    // one pool.
    void RecycleInputBuffer(AlignedBuffer&& buf) {
        if (buf.size() != frame_bytes_) return;
        std::lock_guard<std::mutex> lock(input_pool_mu_);
        if (input_pool_.size() < kMaxRecycledBuffers) {
            input_pool_.push_back(std::move(buf));
        }
    }

    AlignedBuffer GetInputBuffer() {
        {
            std::lock_guard<std::mutex> lock(input_pool_mu_);
            if (!input_pool_.empty()) {
                AlignedBuffer buf = std::move(input_pool_.back());
                input_pool_.pop_back();
                input_pool_hits_.fetch_add(1, std::memory_order_relaxed);
                return buf;
            }
        }
        input_pool_misses_.fetch_add(1, std::memory_order_relaxed);
        return AlignedBuffer(frame_bytes_);
    }

    // Weave field_a_/field_b_ (or copy field_a_ for progressive) directly into
    // a recycled output buffer with the SDK row stride, and schedule it. One
    // pass replaces the old WeaveFields + repack copy chain.
    bool ScheduleWovenOutput(BMDTimeValue display_time, uint64_t schedule_seq) {
        if (!output_) return false;

        const auto t_weave0 = std::chrono::steady_clock::now();

        const AlignedBuffer& a = (field_a_.size() == frame_bytes_) ? field_a_ : black_frame_;
        const AlignedBuffer& b = single_alias_
            ? a
            : ((field_b_.size() == frame_bytes_) ? field_b_ : black_frame_);

        AlignedBuffer out = GetOutputBuffer();
        const size_t line_bytes = static_cast<size_t>(width_) * 4;
        // Phase 11.3: non-temporal stores for the destination — `out` is
        // written once here and handed straight to ScheduleVideoFrame below,
        // never read back by this process, so a normal store's implicit
        // read-for-ownership of the destination cache line is pure waste
        // (docs/phase11-baseline.md §4: this loop measured 2-4ms/call with 3
        // channels contending for L3/memory bandwidth).
        for (int y = 0; y < height_; ++y) {
            const uint8_t* src;
            if (interlaced_) {
                const bool use_first =
                    upper_field_first_ ? ((y % 2) == 0) : ((y % 2) == 1);
                src = use_first ? a.data() : b.data();
            } else {
                src = a.data();
            }
            StreamCopy(
                out.data() + static_cast<size_t>(y) * static_cast<size_t>(row_bytes_),
                src + static_cast<size_t>(y) * line_bytes,
                line_bytes);
        }
        StreamCopyFence();
        RecordStageTime(weave_us_sum_, weave_us_max_, weave_us_count_, t_weave0);
        weave_copy_bytes_.fetch_add(
            static_cast<uint64_t>(row_bytes_) * static_cast<uint64_t>(height_),
            std::memory_order_relaxed);

        const auto t_sched0 = std::chrono::steady_clock::now();
        auto* frame = new OwnedDecklinkFrame(
            width_, height_, row_bytes_, std::move(out), schedule_seq);
        const HRESULT hr = output_->ScheduleVideoFrame(
            frame, display_time, frame_duration_, time_scale_);
        frame->Release();
        RecordStageTime(schedule_us_sum_, schedule_us_max_, schedule_us_count_, t_sched0);

        if (hr != S_OK) return false;
        scheduled_.fetch_add(1, std::memory_order_relaxed);
        return true;
    }

    // Accumulate a stage's elapsed time (since t0) into running sum/max/count
    // atomics. Used for the 5s telemetry window's stage-time breakdown
    // (Phase 11.1 baseline: copy/weave/schedule as a fraction of frame budget).
    static void RecordStageTime(std::atomic<uint64_t>& sum, std::atomic<uint64_t>& max_val,
                                 std::atomic<uint64_t>& count,
                                 std::chrono::steady_clock::time_point t0) {
        const uint64_t us = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - t0)
                .count());
        sum.fetch_add(us, std::memory_order_relaxed);
        count.fetch_add(1, std::memory_order_relaxed);
        uint64_t prev_max = max_val.load(std::memory_order_relaxed);
        while (us > prev_max &&
               !max_val.compare_exchange_weak(prev_max, us, std::memory_order_relaxed)) {
        }
    }

    bool ScheduleVideoBuffer(const AlignedBuffer& bgra, BMDTimeValue display_time) {
        if (!output_ || bgra.size() != frame_bytes_) return false;

        const size_t src_row_bytes = static_cast<size_t>(width_) * 4;
        AlignedBuffer packed = GetOutputBuffer();
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

        auto* frame = new OwnedDecklinkFrame(
            width_, height_, row_bytes_, std::move(packed), 0);
        const HRESULT hr = output_->ScheduleVideoFrame(
            frame, display_time, frame_duration_, time_scale_);
        frame->Release();

        if (hr != S_OK) return false;
        scheduled_.fetch_add(1, std::memory_order_relaxed);
        return true;
    }

    // Phase 11.2 made DeckLink the render pump's clock (WaitForTick requests
    // exactly the fields it's about to consume, paced ~1 field apart), so
    // the queue should hover at 0-1 in steady state. Phase 18 Fallback may
    // deliver two unique bitmaps back-to-back within one output-frame window
    // (eager sequential field packing); depth 3 absorbs that burst without
    // frames_overwritten dropping the intermediate field needed for d_pairs.
    // (Depth 2 = 40ms was enough pre-18; depth 4 / 80ms predates 11.2.)
    static constexpr size_t kMaxQueuedFrames = 3;
    static constexpr size_t kMaxRecycledBuffers = 8;

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
    bool low_latency_applied_ = false;
    std::unique_ptr<DecklinkEventLog> event_log_;
    uint64_t next_schedule_seq_ = 0;

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
    AlignedBuffer black_frame_;

    // Current output pair (completion callback thread only). For interlaced
    // modes field_a_ = temporally older field, field_b_ = newer; for
    // progressive field_a_ holds the whole frame.
    AlignedBuffer field_a_;
    AlignedBuffer field_b_;
    uint64_t field_a_seq_ = 0;
    uint64_t field_b_seq_ = 0;
    size_t last_queue_depth_before_ = 0;
    // Interlaced singles: field_a_ is intentionally reused for both fields;
    // field_b_ stays empty and must not be recycled/owned twice.
    bool single_alias_ = false;

    std::mutex recycle_mu_;
    std::vector<AlignedBuffer> recycle_pool_;

    // Phase 11.3: pool for frame_bytes_-sized input buffers (OnFrame's queue
    // slots + field_a_/field_b_). Separate from recycle_pool_ above because
    // output buffers are row_bytes_*height_-sized (SDK stride can exceed
    // width*4) while input buffers are always exactly frame_bytes_.
    std::mutex input_pool_mu_;
    std::vector<AlignedBuffer> input_pool_;

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
    std::atomic<uint64_t> starved_{0};  // queue empty on pull -> full-frame repeat
    std::atomic<uint64_t> pairs_{0};    // interlaced: 2 fresh fields woven
    std::atomic<uint64_t> singles_{0};  // interlaced: 1 fresh frame duplicated to both fields
    std::atomic<uint64_t> alias_singles_{0};

    // Stage-time telemetry (Phase 11.1): microsecond sum/max/count per stage,
    // reset each 5s window in MaybeLogTelemetry. copy_us_* is the render-thread
    // OnFrame memcpy into the input queue; weave_us_*/schedule_us_* are the
    // completion-callback-thread field weave and IDeckLinkOutput::ScheduleVideoFrame
    // call. Reported as avg/max us and avg as % of the per-output-frame time
    // budget (frame_duration_/time_scale_) so regressions are visible without
    // re-deriving them from raw counters.
    std::atomic<uint64_t> copy_us_sum_{0}, copy_us_max_{0}, copy_us_count_{0};
    std::atomic<uint64_t> weave_us_sum_{0}, weave_us_max_{0}, weave_us_count_{0};
    std::atomic<uint64_t> schedule_us_sum_{0}, schedule_us_max_{0}, schedule_us_count_{0};
    std::atomic<uint64_t> ring_copy_us_sum_{0}, ring_copy_us_max_{0}, ring_copy_count_{0};
    std::atomic<uint64_t> ring_copy_bytes_{0};
    std::atomic<uint64_t> input_pool_us_sum_{0}, input_pool_us_max_{0}, input_pool_us_count_{0};
    std::atomic<uint64_t> onframe_memcpy_us_sum_{0}, onframe_memcpy_us_max_{0},
                          onframe_memcpy_us_count_{0};
    std::atomic<uint64_t> onframe_copy_bytes_{0};
    std::atomic<uint64_t> singles_clone_us_sum_{0}, singles_clone_us_max_{0},
                          singles_clone_us_count_{0};
    std::atomic<uint64_t> singles_clone_bytes_{0};
    std::atomic<uint64_t> weave_copy_bytes_{0};
    std::atomic<uint64_t> input_pool_hits_{0}, input_pool_misses_{0};
    std::atomic<uint64_t> output_pool_hits_{0}, output_pool_misses_{0};
    std::atomic<uint64_t> direct_deliveries_{0}, direct_delivery_bytes_{0};

    // Telemetry window state (touched only on the completion callback thread).
    std::chrono::steady_clock::time_point telemetry_last_{};
    uint64_t prev_in_ = 0, prev_completed_ = 0, prev_late_ = 0,
             prev_dropped_ = 0, prev_flushed_ = 0, prev_overwritten_ = 0,
             prev_starved_ = 0, prev_pairs_ = 0, prev_singles_ = 0,
             prev_alias_singles_ = 0;

    OutputCallback output_callback_{this};
    ProfileCallback profile_callback_{this};
};

DecklinkConsumer::DecklinkConsumer(int device_index, std::string display_mode,
                                   KeyerMode keyer_mode,
                                   std::string completion_log_path)
    : impl_(std::make_unique<Impl>(
        device_index, std::move(display_mode), keyer_mode,
        std::move(completion_log_path))) {}

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

bool DecklinkConsumer::HasExternalClock() const {
    return impl_ != nullptr;
}

int DecklinkConsumer::WaitForTick(int64_t timeout_us) {
    return impl_ ? impl_->WaitForTick(timeout_us) : 0;
}

void DecklinkConsumer::RecordRingCopy(uint64_t us, size_t bytes) {
    if (impl_) impl_->RecordRingCopy(us, bytes);
}

void DecklinkConsumer::RecordDirectDelivery(size_t bytes) {
    if (impl_) impl_->RecordDirectDelivery(bytes);
}

}  // namespace bg
