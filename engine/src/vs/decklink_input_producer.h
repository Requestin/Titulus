// engine/src/vs/decklink_input_producer.h
//
// DeckLink SDI capture producer for bg_vs_engine.
// Reimplemented by reference from CasparCG modules/decklink/producer/
// (callback VideoInputFrameArrived → BGRA). GPL code is not copied.

#ifndef BG_VS_DECKLINK_INPUT_PRODUCER_H
#define BG_VS_DECKLINK_INPUT_PRODUCER_H

#include "vs/producer.h"

#include <atomic>
#include <memory>
#include <string>

namespace bg {
namespace vs {

class DecklinkInputProducer final : public Producer {
  public:
    DecklinkInputProducer(int device_index, std::string display_mode);
    ~DecklinkInputProducer() override;

    bool Start(int width, int height, int fps) override;
    void Stop() override;
    const char* Label() const override;
    LatestFrameBuffer& Buffer() override { return buffer_; }

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    LatestFrameBuffer buffer_;
    std::string label_;
};

// Factory: real DeckLink when BG_ENABLE_DECKLINK; otherwise falls back to FileProducer green_screen.
std::unique_ptr<Producer> MakeCameraProducer(int device_index,
                                             const std::string& display_mode,
                                             const std::string& cam_file);

}  // namespace vs
}  // namespace bg

#endif
