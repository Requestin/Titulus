// engine/src/vs/decklink_input_producer.cpp
//
// Clean-room DeckLink input capture for bg_vs_engine.
// Reimplemented by reference from CasparCG modules/decklink/producer/ semantics
// (VideoInputFrameArrived → BGRA latest-frame). See docs/CASPARRCG_PORTING.md.

#include "vs/decklink_input_producer.h"
#include "vs/file_producer.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <string>
#include <vector>

#if defined(BG_ENABLE_DECKLINK)
#include "DeckLinkAPI.h"
#endif

namespace bg {
namespace vs {

#if defined(BG_ENABLE_DECKLINK)

namespace {

template <typename T>
void release_com(T*& p) {
    if (p) {
        p->Release();
        p = nullptr;
    }
}

using CreateIteratorFn = IDeckLinkIterator* (*)();

BMDDisplayMode ParseMode(const std::string& name) {
    if (name == "HD1080p50") return bmdModeHD1080p50;
    if (name == "HD1080p25") return bmdModeHD1080p25;
    if (name == "HD1080i60" || name == "HD1080i6000") return bmdModeHD1080i6000;
    if (name == "HD720p60") return bmdModeHD720p60;
    return bmdModeHD1080i50;
}

}  // namespace

struct DecklinkInputProducer::Impl : public IDeckLinkInputCallback {
    Impl(int device_index, std::string display_mode, LatestFrameBuffer* buffer)
        : device_index_(device_index), display_mode_(std::move(display_mode)), buffer_(buffer) {}

    ~Impl() { StopCapture(); }

    bool StartCapture(int /*width*/, int /*height*/, int /*fps*/) {
        if (!LoadRuntime()) return false;

        IDeckLinkIterator* it = create_iterator_();
        if (!it) {
            std::fprintf(stderr, "bg_vs_engine: CreateDeckLinkIteratorInstance returned null\n");
            return false;
        }

        IDeckLink* device = nullptr;
        int idx = 0;
        while (it->Next(&device) == S_OK) {
            if (idx == device_index_) break;
            release_com(device);
            ++idx;
        }
        release_com(it);
        if (!device) {
            std::fprintf(stderr, "bg_vs_engine: DeckLink input device %d not found\n", device_index_);
            return false;
        }
        device_ = device;

        if (device_->QueryInterface(IID_IDeckLinkInput, reinterpret_cast<void**>(&input_)) != S_OK || !input_) {
            std::fprintf(stderr, "bg_vs_engine: IDeckLinkInput not available on device %d\n", device_index_);
            StopCapture();
            return false;
        }

        const BMDDisplayMode mode = ParseMode(display_mode_);
        BMDDisplayMode actual = bmdModeUnknown;
        bool supported = false;
        if (input_->DoesSupportVideoMode(
                bmdVideoConnectionUnspecified,
                mode,
                bmdFormat8BitBGRA,
                bmdNoVideoInputConversion,
                bmdSupportedVideoModeDefault,
                &actual,
                &supported) != S_OK || !supported) {
            std::fprintf(stderr, "bg_vs_engine: input mode %s / BGRA not supported\n",
                         display_mode_.c_str());
            StopCapture();
            return false;
        }

        input_->SetCallback(this);
        callback_set_ = true;

        if (input_->EnableVideoInput(mode, bmdFormat8BitBGRA, bmdVideoInputFlagDefault) != S_OK) {
            std::fprintf(stderr, "bg_vs_engine: EnableVideoInput failed\n");
            StopCapture();
            return false;
        }
        if (input_->StartStreams() != S_OK) {
            std::fprintf(stderr, "bg_vs_engine: StartStreams failed\n");
            StopCapture();
            return false;
        }
        running_ = true;
        return true;
    }

    void StopCapture() {
        if (input_ && running_) {
            input_->StopStreams();
            input_->DisableVideoInput();
        }
        running_ = false;
        if (input_ && callback_set_) {
            input_->SetCallback(nullptr);
            callback_set_ = false;
        }
        release_com(input_);
        release_com(device_);
        if (decklink_lib_) {
            // Keep library loaded for process lifetime (same as consumer).
        }
    }

    bool LoadRuntime() {
        if (create_iterator_) return true;
        decklink_lib_ = dlopen("libDeckLinkAPI.so", RTLD_NOW | RTLD_LOCAL);
        if (!decklink_lib_) {
            std::fprintf(stderr, "bg_vs_engine: dlopen(libDeckLinkAPI.so) failed\n");
            return false;
        }
        static constexpr const char* kSymbols[] = {
            "CreateDeckLinkIteratorInstance",
            "CreateDeckLinkIteratorInstance_0004",
            "CreateDeckLinkIteratorInstance_0003",
            "CreateDeckLinkIteratorInstance_0002",
        };
        for (const char* sym : kSymbols) {
            create_iterator_ = reinterpret_cast<CreateIteratorFn>(dlsym(decklink_lib_, sym));
            if (create_iterator_) break;
        }
        if (!create_iterator_) {
            std::fprintf(stderr, "bg_vs_engine: CreateDeckLinkIteratorInstance* not found\n");
            return false;
        }
        return true;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* ppv) override {
        if (!ppv) return E_INVALIDARG;
        const REFIID iid_unknown = IID_IUnknown;
        const REFIID iid_cb = IID_IDeckLinkInputCallback;
        if (std::memcmp(&iid, &iid_unknown, sizeof(REFIID)) == 0
            || std::memcmp(&iid, &iid_cb, sizeof(REFIID)) == 0) {
            *ppv = static_cast<IDeckLinkInputCallback*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return ++ref_; }
    ULONG STDMETHODCALLTYPE Release() override { return --ref_; }

    HRESULT STDMETHODCALLTYPE VideoInputFormatChanged(
        BMDVideoInputFormatChangedEvents /*events*/,
        IDeckLinkDisplayMode* /*newMode*/,
        BMDDetectedVideoInputFormatFlags /*flags*/) override {
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE VideoInputFrameArrived(
        IDeckLinkVideoInputFrame* video,
        IDeckLinkAudioInputPacket* /*audio*/) override {
        if (!video || !buffer_) return S_OK;

        IDeckLinkVideoBuffer* vbuf = nullptr;
        void* bytes = nullptr;
        if (video->QueryInterface(IID_IDeckLinkVideoBuffer, reinterpret_cast<void**>(&vbuf)) == S_OK
            && vbuf) {
            if (vbuf->GetBytes(&bytes) != S_OK) bytes = nullptr;
            release_com(vbuf);
        }
        if (!bytes) return S_OK;

        const long w = video->GetWidth();
        const long h = video->GetHeight();
        const long row = video->GetRowBytes();
        if (w <= 0 || h <= 0 || row < w * 4) return S_OK;

        if (row == w * 4) {
            buffer_->Publish(static_cast<const uint8_t*>(bytes),
                             static_cast<int>(w), static_cast<int>(h));
        } else {
            scratch_.resize(static_cast<size_t>(w) * static_cast<size_t>(h) * 4u);
            const auto* src = static_cast<const uint8_t*>(bytes);
            for (long y = 0; y < h; ++y) {
                std::memcpy(
                    scratch_.data() + static_cast<size_t>(y) * static_cast<size_t>(w) * 4u,
                    src + static_cast<size_t>(y) * static_cast<size_t>(row),
                    static_cast<size_t>(w) * 4u);
            }
            buffer_->Publish(scratch_.data(), static_cast<int>(w), static_cast<int>(h));
        }
        return S_OK;
    }

    int device_index_ = 0;
    std::string display_mode_;
    LatestFrameBuffer* buffer_ = nullptr;
    void* decklink_lib_ = nullptr;
    CreateIteratorFn create_iterator_ = nullptr;
    IDeckLink* device_ = nullptr;
    IDeckLinkInput* input_ = nullptr;
    bool running_ = false;
    bool callback_set_ = false;
    std::atomic<ULONG> ref_{1};
    std::vector<uint8_t> scratch_;
};

DecklinkInputProducer::DecklinkInputProducer(int device_index, std::string display_mode)
    : impl_(std::make_unique<Impl>(device_index, std::move(display_mode), &buffer_)) {
    label_ = "decklink_in[" + std::to_string(device_index) + "]";
}

DecklinkInputProducer::~DecklinkInputProducer() { Stop(); }

bool DecklinkInputProducer::Start(int width, int height, int fps) {
    return impl_ && impl_->StartCapture(width, height, fps);
}

void DecklinkInputProducer::Stop() {
    if (impl_) impl_->StopCapture();
}

const char* DecklinkInputProducer::Label() const { return label_.c_str(); }

#else  // !BG_ENABLE_DECKLINK

struct DecklinkInputProducer::Impl {};

DecklinkInputProducer::DecklinkInputProducer(int /*device_index*/, std::string /*display_mode*/)
    : impl_(nullptr) {
    label_ = "decklink_in[disabled]";
}

DecklinkInputProducer::~DecklinkInputProducer() = default;

bool DecklinkInputProducer::Start(int /*width*/, int /*height*/, int /*fps*/) {
    std::fprintf(stderr, "bg_vs_engine: DeckLink input not built (BG_ENABLE_DECKLINK off)\n");
    return false;
}

void DecklinkInputProducer::Stop() {}

const char* DecklinkInputProducer::Label() const { return label_.c_str(); }

#endif

std::unique_ptr<Producer> MakeCameraProducer(int device_index,
                                             const std::string& display_mode,
                                             const std::string& cam_file) {
#if defined(BG_ENABLE_DECKLINK)
    if (device_index >= 0) {
        return std::make_unique<DecklinkInputProducer>(device_index, display_mode);
    }
#else
    (void)display_mode;
    if (device_index >= 0) {
        std::fprintf(stderr,
                     "bg_vs_engine: vs_input_device=%d requested but DeckLink not built — using file/stub\n",
                     device_index);
    }
#endif
    return std::make_unique<FileProducer>(cam_file, "green_screen", "cam_file");
}

}  // namespace vs
}  // namespace bg
