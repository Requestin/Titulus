// engine/src/pacing_message_parser.cpp — see pacing_message_parser.h.

#include "pacing_message_parser.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <utility>

namespace bg {
namespace {

constexpr std::string_view kHeader{"BGPACING v1 "};
constexpr size_t kMaxTemplateIdBytes = 128;
constexpr uint32_t kMaxActiveTemplates = 64;
constexpr uint32_t kMaxTicksPerRaf = 4;

enum class Field : uint8_t {
    Event,
    Raf,
    Perf,
    Unix,
    Delta,
    Ticks,
    FrameBefore,
    FrameAfter,
    Active,
    Valid,
    Template,
    Graph,
    State,
    Count,
};

constexpr std::array<std::pair<std::string_view, Field>,
                     static_cast<size_t>(Field::Count)>
    kFields{{
        {"ev", Field::Event},
        {"raf", Field::Raf},
        {"rperf", Field::Perf},
        {"runix", Field::Unix},
        {"rdelta", Field::Delta},
        {"ticks", Field::Ticks},
        {"lf_before", Field::FrameBefore},
        {"lf_after", Field::FrameAfter},
        {"active", Field::Active},
        {"valid", Field::Valid},
        {"template", Field::Template},
        {"graph", Field::Graph},
        {"state", Field::State},
    }};

bool ParseUnsigned(std::string_view text, uint64_t* out) {
    if (text.empty() || !out) return false;
    uint64_t value = 0;
    const auto result = std::from_chars(
        text.data(), text.data() + text.size(), value);
    if (result.ec != std::errc{} || result.ptr != text.data() + text.size()) {
        return false;
    }
    *out = value;
    return true;
}

bool IsSafeTemplateId(std::string_view value) {
    if (value.empty() || value.size() > kMaxTemplateIdBytes) return false;
    for (const char character : value) {
        const bool alpha = (character >= 'a' && character <= 'z')
            || (character >= 'A' && character <= 'Z');
        const bool digit = character >= '0' && character <= '9';
        if (!alpha && !digit && character != '-' && character != '_') {
            return false;
        }
    }
    return true;
}

bool StoreField(RuntimePacingEvent* event, Field field, std::string_view value) {
    if (!event) return false;
    uint64_t number = 0;
    switch (field) {
        case Field::Template:
            if (value == "-") {
                event->template_id.clear();
                return true;
            }
            if (!IsSafeTemplateId(value)) return false;
            event->template_id.assign(value);
            return true;
        case Field::Valid:
            if (!ParseUnsigned(value, &number) || number > 1) return false;
            event->identity_valid = number == 1;
            return true;
        case Field::Event:
            if (!ParseUnsigned(value, &event->runtime_event_seq)
                || event->runtime_event_seq == 0) return false;
            return true;
        case Field::Raf:
            return ParseUnsigned(value, &event->raf_seq);
        case Field::Perf:
            return ParseUnsigned(value, &event->runtime_perf_us);
        case Field::Unix:
            return ParseUnsigned(value, &event->runtime_unix_us);
        case Field::Delta:
            return ParseUnsigned(value, &event->raf_delta_us);
        case Field::Ticks:
            if (!ParseUnsigned(value, &number) || number > kMaxTicksPerRaf) return false;
            event->ticks_per_raf = static_cast<uint32_t>(number);
            return true;
        case Field::FrameBefore:
            return ParseUnsigned(value, &event->logical_frame_before);
        case Field::FrameAfter:
            return ParseUnsigned(value, &event->logical_frame_after);
        case Field::Active:
            if (!ParseUnsigned(value, &number) || number > kMaxActiveTemplates) return false;
            event->active_count = static_cast<uint32_t>(number);
            return true;
        case Field::Graph:
            return ParseUnsigned(value, &event->graph_revision);
        case Field::State:
            return ParseUnsigned(value, &event->state_revision);
        case Field::Count:
            return false;
    }
    return false;
}

PacingParseResult MalformedResult() {
    return {
        .status = PacingParseStatus::Malformed,
        .event = {},
    };
}

}  // namespace

PacingParseResult ParsePacingMessage(std::string_view message) {
    if (!message.starts_with(kHeader)) return {};

    RuntimePacingEvent event;
    uint32_t seen = 0;
    std::string_view remaining = message.substr(kHeader.size());
    while (!remaining.empty()) {
        const size_t comma = remaining.find(',');
        const std::string_view item = remaining.substr(0, comma);
        remaining = comma == std::string_view::npos
            ? std::string_view{}
            : remaining.substr(comma + 1);

        const size_t equals = item.find('=');
        if (equals == std::string_view::npos || equals == 0
            || equals + 1 >= item.size()) {
            return MalformedResult();
        }
        const std::string_view key = item.substr(0, equals);
        const std::string_view value = item.substr(equals + 1);
        const auto it = std::find_if(
            kFields.begin(), kFields.end(),
            [key](const auto& candidate) { return candidate.first == key; });
        if (it == kFields.end()) return MalformedResult();
        const uint32_t bit = 1u << static_cast<uint8_t>(it->second);
        if ((seen & bit) != 0 || !StoreField(&event, it->second, value)) {
            return MalformedResult();
        }
        seen |= bit;
    }

    constexpr uint32_t kAllFields =
        (1u << static_cast<uint8_t>(Field::Count)) - 1u;
    if (seen != kAllFields
        || (event.identity_valid && event.template_id.empty())
        || (!event.identity_valid && !event.template_id.empty())) {
        return MalformedResult();
    }
    return {.status = PacingParseStatus::Ok, .event = std::move(event)};
}

void RuntimePacingStore::Commit(RuntimePacingEvent event, uint64_t host_unix_us,
                                uint64_t host_mono_us) {
    latest_ = {
        .present = true,
        .event = std::move(event),
        .host_unix_us = host_unix_us,
        .host_mono_us = host_mono_us,
    };
}

RuntimePacingSnapshot RuntimePacingStore::Snapshot() const {
    return latest_;
}

}  // namespace bg
