// engine/src/consumers/null_consumer.h
//
// Null consumer — discards every frame (DEVELOPMENT_PROMPT §9.6).
//
// Used for benchmarking the render pipeline without any output IO: measures the
// pure CEF OSR + memcpy + cadence cost. CasparCG equivalent: the internal
// "none"/discard path used by its benchmarking tools.

#ifndef BG_ENGINE_CONSUMERS_NULL_CONSUMER_H
#define BG_ENGINE_CONSUMERS_NULL_CONSUMER_H

#include "consumers/consumer.h"

namespace bg {

class NullConsumer final : public Consumer {
  public:
    bool Start(int /*width*/, int /*height*/, int /*fps*/) override { return true; }
    void OnFrame(const Frame& /*frame*/) override {}
    void Stop() override {}
    const char* Label() const override { return "null"; }
};

}  // namespace bg

#endif  // BG_ENGINE_CONSUMERS_NULL_CONSUMER_H
