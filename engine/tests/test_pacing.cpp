// engine/tests/test_pacing.cpp
//
// P20.1 RED/GREEN tests for the optional FrameLog v2 evidence schema.

#include "../src/frame_log.h"
#include "../src/decklink_provenance.h"
#include "../src/pacing_message_parser.h"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

struct TestEntry {
    const char* name;
    void (*fn)();
};

std::vector<TestEntry>& Registry() {
    static std::vector<TestEntry> tests;
    return tests;
}

struct Registrar {
    Registrar(const char* name, void (*fn)()) {
        Registry().push_back({name, fn});
    }
};

#define TEST(name)                                                              \
    static void name();                                                         \
    static Registrar g_reg_##name(#name, name);                                 \
    static void name()

#define FAIL(msg)                                                               \
    do {                                                                        \
        std::fprintf(stderr, "  FAIL: %s\n", msg);                              \
        ++g_failures;                                                           \
        return;                                                                 \
    } while (0)

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (!(cond)) FAIL(msg);                                                 \
    } while (0)

std::filesystem::path UniquePath(const char* suffix) {
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    return std::filesystem::temp_directory_path()
        / (std::string("titulus-pacing-") + std::to_string(stamp) + suffix);
}

std::string ReadAll(const std::filesystem::path& path) {
    std::ifstream input(path);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

}  // namespace

TEST(DisabledFrameLogDoesNotCreateOutput) {
    bg::FrameLog log("");
    CHECK(!log.enabled(), "empty path must disable frame log");

    const bg::FrameLogRecord record{
        .unix_us = 1,
        .mono_us = 2,
    };
    log.RecordTick(record);
}

TEST(FrameLogV2WritesDualClocksAndPacingColumns) {
    const auto path = UniquePath(".csv");
    {
        bg::FrameLog log(path.string());
        CHECK(log.enabled(), "temporary frame log failed to open");
        const bg::FrameLogRecord record{
            .unix_us = 1'725'000'000'123'456ULL,
            .mono_us = 123'456ULL,
            .interval_us = 20'000,
            .begin_frame_token = 7,
            .batch_id = 3,
            .batch_index = 1,
            .batch_size = 2,
            .cef_paint_before = 40,
            .cef_paint_after = 41,
            .publish_seq_before = 50,
            .publish_seq_after = 51,
            .delivery_kind = bg::FrameDeliveryKind::CefForward,
            .pump_active_us = 900,
            .paint_latency_us = 1'200,
            .deadline_miss = false,
        };
        log.RecordTick(record);
    }

    const std::string content = ReadAll(path);
    std::filesystem::remove(path);
    CHECK(content.starts_with(
              "schema_version,unix_us,mono_us,interval_us,begin_frame_token,batch_id,"),
          "v2 header must lead with explicit dual-clock columns");
    CHECK(content.find("1725000000123456,123456,20000,7,3,1,2,40,41,50,51,cef_forward")
              != std::string::npos,
          "v2 record must preserve explicit provenance values");
    CHECK(content.find("wall_clock_us") == std::string::npos,
          "steady-clock epoch must not be labelled wall clock");
}

TEST(ParsesBoundedRuntimePacingEvent) {
    const auto parsed = bg::ParsePacingMessage(
        "BGPACING v1 ev=7,raf=11,rperf=22000,runix=1725000000000000,"
        "rdelta=20000,ticks=2,lf_before=100,lf_after=102,active=1,valid=1,"
        "template=template-1,graph=3,state=9");
    CHECK(parsed.status == bg::PacingParseStatus::Ok, "valid pacing message rejected");
    CHECK(parsed.event.runtime_event_seq == 7, "runtime event sequence mismatch");
    CHECK(parsed.event.ticks_per_raf == 2, "tick count mismatch");
    CHECK(parsed.event.logical_frame_before == 100, "logical frame before mismatch");
    CHECK(parsed.event.logical_frame_after == 102, "logical frame after mismatch");
    CHECK(parsed.event.identity_valid, "identity validity mismatch");
    CHECK(parsed.event.template_id == "template-1", "template id mismatch");
}

TEST(RejectsDuplicateOrInvalidRuntimePacingFields) {
    const auto duplicate = bg::ParsePacingMessage(
        "BGPACING v1 ev=1,ev=2,raf=1,rperf=1,runix=1,rdelta=1,ticks=1,"
        "lf_before=0,lf_after=1,active=1,valid=0,template=-,graph=0,state=0");
    CHECK(duplicate.status == bg::PacingParseStatus::Malformed,
          "duplicate pacing field accepted");

    const auto invalid = bg::ParsePacingMessage(
        "BGPACING v1 ev=1,raf=1,rperf=1,runix=1,rdelta=1,ticks=1,"
        "lf_before=0,lf_after=1,active=1,valid=1,template=invalid space,"
        "graph=0,state=0");
    CHECK(invalid.status == bg::PacingParseStatus::Malformed,
          "unsafe template identifier accepted");
}

TEST(ClassifiesDecklinkWeaveProvenanceWithoutHardware) {
    const bg::WeaveProvenancePair previous{.field_a_seq = 10, .field_b_seq = 11};
    const auto pair = bg::DecideWeaveProvenance(2, 20, 21, previous);
    CHECK(pair.mode == bg::WeaveProvenanceMode::Pair, "two fresh frames must pair");
    CHECK(pair.woven.field_a_seq == 20 && pair.woven.field_b_seq == 21,
          "pair source order mismatch");

    const auto single = bg::DecideWeaveProvenance(1, 30, 0, previous);
    CHECK(single.mode == bg::WeaveProvenanceMode::Single, "one fresh frame must alias");
    CHECK(single.woven.field_a_seq == 30 && single.woven.field_b_seq == 30,
          "single alias identity mismatch");

    const auto starved = bg::DecideWeaveProvenance(0, 0, 0, previous);
    CHECK(starved.mode == bg::WeaveProvenanceMode::Starved, "empty queue must starve");
    CHECK(starved.woven.field_a_seq == 10 && starved.woven.field_b_seq == 11,
          "starved output must preserve previous pair");
}

int main() {
    for (const auto& test : Registry()) {
        std::fprintf(stderr, "[ RUN      ] %s\n", test.name);
        test.fn();
    }
    if (g_failures == 0) {
        std::fprintf(stderr, "[  PASSED  ] %zu pacing tests\n", Registry().size());
        return 0;
    }
    std::fprintf(stderr, "[  FAILED  ] %d pacing tests\n", g_failures);
    return 1;
}
