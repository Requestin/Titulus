#ifndef BG_ENGINE_PAINT_SEQUENCE_TRACKER_H
#define BG_ENGINE_PAINT_SEQUENCE_TRACKER_H

#include <cstdint>

namespace bg {

class PaintSequenceTracker {
  public:
    explicit PaintSequenceTracker(uint64_t initial_sequence) noexcept
        : observed_sequence_(initial_sequence) {}

    bool Observe(uint64_t sequence) noexcept;

  private:
    uint64_t observed_sequence_ = 0;
};

}  // namespace bg

#endif  // BG_ENGINE_PAINT_SEQUENCE_TRACKER_H
