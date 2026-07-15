// engine/src/mixer/graph_message_parser.h
//
// Parser for the bounded layer protocol v1 wire format. Stateless and
// allocation-free except for the snapshot output. Designed to run on the CEF
// UI thread inside OnConsoleMessage without blocking the message pump.

#ifndef BG_ENGINE_MIXER_GRAPH_MESSAGE_PARSER_H
#define BG_ENGINE_MIXER_GRAPH_MESSAGE_PARSER_H

#include "protocol_types.h"

#include <optional>
#include <string_view>

namespace bg {

enum class GraphParseStatus : uint8_t {
    Ok,
    NotGraphMessage,         // not a "BGGRAPH v1 ..." line
    MalformedJson,
    BoundsViolation,         // layer count / string length / extent exceeded
    UnsupportedVersion,      // header version != 1
    MissingRequiredField,    // type / rev / layers / id
    UnsupportedFieldValue,   // unknown enum label
};

struct GraphParseResult {
    GraphParseStatus status = GraphParseStatus::NotGraphMessage;
    ProtocolSnapshot snapshot;
    std::string error_detail;  // populated on failure
};

// Parses a single console line. If the line is not a BGGRAPH message, returns
// status=NotGraphMessage (caller should ignore). Otherwise either Ok + snapshot
// or an explicit failure.
GraphParseResult ParseGraphMessage(std::string_view line);

}  // namespace bg

#endif  // BG_ENGINE_MIXER_GRAPH_MESSAGE_PARSER_H
