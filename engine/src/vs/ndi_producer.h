// engine/src/vs/ndi_producer.h — Unreal frame ingest (NDI or file/stub).

#ifndef BG_VS_NDI_PRODUCER_H
#define BG_VS_NDI_PRODUCER_H

#include "vs/producer.h"

#include <memory>
#include <string>

namespace bg {
namespace vs {

// When BG_ENABLE_NDI is set and NDI SDK is linked, connects to source_name.
// Otherwise uses FileProducer with pattern "flat" (or bg_file raw BGRA).
std::unique_ptr<Producer> MakeUnrealProducer(const std::string& ndi_source,
                                             const std::string& bg_file);

}  // namespace vs
}  // namespace bg

#endif
