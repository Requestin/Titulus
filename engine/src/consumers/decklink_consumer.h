#ifndef BG_ENGINE_CONSUMERS_DECKLINK_CONSUMER_H
#define BG_ENGINE_CONSUMERS_DECKLINK_CONSUMER_H

#include "config.h"
#include "consumers/consumer.h"

#include <memory>
#include <string>

namespace bg {

// DeckLink SDI output consumer (Phase 3):
// - Scheduled playback pacing via IDeckLinkVideoOutputCallback
// - Keyer control: external/internal/fill-only
// - Interlaced weave (UFF/LFF) from progressive BGRA frame stream
// - Controlled restart request (exit 42) on profile-change events
class DecklinkConsumer final : public Consumer {
  public:
    DecklinkConsumer(int device_index, std::string display_mode, KeyerMode keyer_mode);
    ~DecklinkConsumer() override;

    bool Start(int width, int height, int fps) override;
    void OnFrame(const Frame& frame) override;
    void Stop() override;
    const char* Label() const override;
    int PollExitCode() const override;

    // Phase 11.2: DeckLink is the hardware clock — see consumer.h.
    bool HasExternalClock() const override;
    int WaitForTick(int64_t timeout_us) override;
    void RecordRingCopy(uint64_t us, size_t bytes) override;
    void RecordDirectDelivery(size_t bytes) override;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace bg

#endif  // BG_ENGINE_CONSUMERS_DECKLINK_CONSUMER_H
