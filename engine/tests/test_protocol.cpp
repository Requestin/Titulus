// engine/tests/test_protocol.cpp
//
// CTest harness for the bounded layer protocol v1 parser and the
// RenderGraphStore shadow store.

#include "../src/mixer/graph_message_parser.h"
#include "../src/mixer/protocol_types.h"
#include "../src/mixer/render_graph_store.h"

#include <cstdio>
#include <string>
#include <vector>

namespace {

int g_failures = 0;

struct TestEntry {
    const char* name;
    void (*fn)();
};

std::vector<TestEntry>& Registry() {
    static std::vector<TestEntry> v;
    return v;
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

}  // namespace

// ---------------------------------------------------------------------------

TEST(IgnoresUnrelatedConsoleLine) {
    auto r = bg::ParseGraphMessage("BGSTATS fps=25 d_pairs=0");
    CHECK(r.status == bg::GraphParseStatus::NotGraphMessage,
          "stats line treated as graph message");
}

TEST(ParsesMinimalSnapshot) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","template_id":"test1","rev":7,"layers":[]})");
    CHECK(r.status == bg::GraphParseStatus::Ok, "minimal snapshot failed");
    CHECK(r.snapshot.template_id == "test1", "template id mismatch");
    CHECK(r.snapshot.graph_revision == 7u, "graph revision mismatch");
    CHECK(r.snapshot.state_revision == 0u, "legacy state revision mismatch");
    CHECK(r.snapshot.layers.empty(), "expected zero layers");
}

TEST(ParsesSingleLayer) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1,"layers":[)"
        R"({"id":"a","kind":"cached_bitmap","dirty":["props_dirty"],)"
        R"("opacity":0.5,"mask_mode":"none","x":10,"y":20,"sx":1.0,"sy":1.0,)"
        R"("rot":0.0,"ax":0.0,"ay":0.0,"sw":1920,"sh":1080}]})");
    CHECK(r.status == bg::GraphParseStatus::Ok, "layer snapshot failed");
    CHECK(r.snapshot.layers.size() == 1, "expected 1 layer");
    const auto& node = r.snapshot.layers[0];
    CHECK(node.id == "a", "id mismatch");
    CHECK(node.kind == bg::ProtocolNodeKind::CachedBitmap, "kind mismatch");
    CHECK(node.opacity == 0.5f, "opacity mismatch");
    CHECK(node.layout_position.x == 10, "x mismatch");
    CHECK(node.source_w == 1920, "source_w mismatch");
    CHECK(node.dirty.size() == 1, "expected one dirty");
    CHECK(node.dirty[0] == bg::ProtocolDirtyDomain::PropsDirty, "dirty mismatch");
}

TEST(ParsesBoundedContentInvalidation) {
    const std::string layer =
        R"({"id":"a","kind":"cached_bitmap","dirty":["content_dirty"],)"
        R"("opacity":1,"mask_mode":"none","x":0,"y":0,"sx":1,"sy":1,)"
        R"("rot":0,"ax":0,"ay":0,"sw":1,"sh":1})";
    auto valid = bg::ParseGraphMessage(
        "BGGRAPH v1 {\"type\":\"snapshot\",\"graph_rev\":1,"
        "\"state_rev\":2,\"invalidate\":[\"a\"],\"layers\":["
        + layer + "]}");
    CHECK(valid.status == bg::GraphParseStatus::Ok,
          "valid content invalidation rejected");
    CHECK(valid.snapshot.invalidated_layer_ids
              == std::vector<std::string>{"a"},
          "content invalidation id lost");

    auto unknown = bg::ParseGraphMessage(
        "BGGRAPH v1 {\"type\":\"snapshot\",\"graph_rev\":1,"
        "\"state_rev\":2,\"invalidate\":[\"missing\"],\"layers\":["
        + layer + "]}");
    CHECK(unknown.status == bg::GraphParseStatus::BoundsViolation,
          "unknown content invalidation accepted");
}

TEST(RejectsMissingLayersField) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1})");
    CHECK(r.status == bg::GraphParseStatus::MissingRequiredField,
          "missing layers should be flagged");
}

TEST(RejectsUnknownKind) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1,"layers":[)"
        R"({"id":"a","kind":"magic"}]})");
    CHECK(r.status == bg::GraphParseStatus::MalformedJson
          || r.status == bg::GraphParseStatus::UnsupportedFieldValue,
          "unknown kind should be rejected");
}

TEST(RejectsBadHeader) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v2 {"type":"snapshot","rev":1,"layers":[]})");
    CHECK(r.status == bg::GraphParseStatus::NotGraphMessage,
          "v2 header should not match v1");
}

TEST(RejectsUnknownObjectKey) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1,"layers":[},)"
        R"("bogus":1])");
    CHECK(r.status == bg::GraphParseStatus::MalformedJson,
          "unknown top-level key should be rejected");
}

TEST(RejectsDuplicateTopLevelKey) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","type":"snapshot","rev":1,"layers":[]})");
    CHECK(r.status == bg::GraphParseStatus::MalformedJson,
          "duplicate top-level key should be rejected");
}

TEST(RejectsDuplicateLayerKey) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1,"layers":[)"
        R"({"id":"a","kind":"cached_bitmap","opacity":0.5,"opacity":1,)"
        R"("sw":1,"sh":1}]})");
    CHECK(r.status == bg::GraphParseStatus::MalformedJson,
          "duplicate layer key should be rejected");
}

TEST(RejectsExcessiveLayerCount) {
    std::string layers = "[";
    for (size_t i = 0; i < 128; ++i) {
        layers += R"({"id":"a","kind":"live_html"},)";
    }
    layers.pop_back();  // drop last comma
    layers += "]";
    const std::string msg =
        "BGGRAPH v1 {\"type\":\"snapshot\",\"rev\":1,\"layers\":" + layers + "}";
    auto r = bg::ParseGraphMessage(msg);
    CHECK(r.status == bg::GraphParseStatus::BoundsViolation,
          "excessive layer count should violate bounds");
}

TEST(HandlesEscapedId) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1,"layers":[)"
        R"({"id":"a\"b\\c","kind":"live_html","sw":1,"sh":1}]})");
    CHECK(r.status == bg::GraphParseStatus::Ok, "escaped id failed");
    CHECK(!r.snapshot.layers.empty(), "expected one layer");
    CHECK(r.snapshot.layers[0].id == "a\"b\\c", "unescape mismatch");
}

TEST(MaskRectParsed) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1,"layers":[)"
        R"({"id":"m","kind":"mask_operator","mask_mode":"inverted",)"
        R"("rect":[10,20,300,400]}]})");
    CHECK(r.status == bg::GraphParseStatus::Ok, "mask snapshot failed");
    const auto& node = r.snapshot.layers[0];
    CHECK(node.mask_mode == bg::ProtocolMaskMode::Inverted, "mask mode mismatch");
    CHECK(node.mask_rect.x == 10, "rect x mismatch");
    CHECK(node.mask_rect.y == 20, "rect y mismatch");
    CHECK(node.mask_rect.width == 300, "rect w mismatch");
    CHECK(node.mask_rect.height == 400, "rect h mismatch");
}

TEST(ParsesAffineAndMaskAffectedSources) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","graph_rev":4,"state_rev":9,"layers":[)"
        R"({"id":"a","kind":"cached_bitmap","sw":10,"sh":20,)"
        R"("m":[1,0,100,0,1,200]},)"
        R"({"id":"m","kind":"mask_operator","mask_mode":"normal",)"
        R"("rect":[0,0,50,50],"affects":["a"]}]})");
    CHECK(r.status == bg::GraphParseStatus::Ok,
          "affine/affected snapshot failed");
    CHECK(r.snapshot.graph_revision == 4u, "graph revision");
    CHECK(r.snapshot.state_revision == 9u, "state revision");
    CHECK(r.snapshot.layers[0].has_affine, "affine flag");
    CHECK(r.snapshot.layers[0].affine[2] == 100.0f,
          "affine translation");
    CHECK(r.snapshot.layers[1].affected_source_ids.size() == 1,
          "affected source count");
    CHECK(r.snapshot.layers[1].affected_source_ids[0] == "a",
          "affected source id");
}

TEST(RejectsSingularAffineAndUnknownAffectedSource) {
    auto singular = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","graph_rev":1,"state_rev":1,"layers":[)"
        R"({"id":"a","kind":"cached_bitmap","sw":1,"sh":1,)"
        R"("m":[1,0,0,0,0,0]}]})");
    CHECK(singular.status == bg::GraphParseStatus::BoundsViolation,
          "singular affine accepted");
    auto unknown = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","graph_rev":1,"state_rev":1,"layers":[)"
        R"({"id":"m","kind":"mask_operator","affects":["missing"]}]})");
    CHECK(unknown.status == bg::GraphParseStatus::BoundsViolation,
          "unknown affected source accepted");
}

TEST(UnsupportedReasonsParsed) {
    auto r = bg::ParseGraphMessage(
        R"(BGGRAPH v1 {"type":"snapshot","rev":1,"layers":[)"
        R"({"id":"a","kind":"cached_bitmap","sw":1,"sh":1,"unsupported":[)"
        R"("fractional_rotation","three_d_transform","non_normal_blend"]}]})");
    CHECK(r.status == bg::GraphParseStatus::Ok, "unsupported list failed");
    const auto& node = r.snapshot.layers[0];
    CHECK(node.unsupported.size() == 3, "expected 3 unsupported reasons");
    CHECK(node.unsupported[0] ==
          bg::ProtocolUnsupportedReason::FractionalRotation,
          "first reason mismatch");
    CHECK(node.unsupported[1] == bg::ProtocolUnsupportedReason::ThreeDTransform,
          "second reason mismatch");
    CHECK(node.unsupported[2] == bg::ProtocolUnsupportedReason::NonNormalBlend,
          "third reason mismatch");
}

TEST(StoreAcceptsStrictlyNewer) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot s1;
    s1.graph_revision = 1;
    s1.state_revision = 1;
    CHECK(store.Commit(std::move(s1)), "first commit rejected");
    CHECK(store.Stats().accepted == 1, "accepted count");
    bg::ProtocolSnapshot s2;
    s2.graph_revision = 1;
    s2.state_revision = 5;
    s2.layers.emplace_back();
    CHECK(store.Commit(std::move(s2)), "second commit rejected");
    CHECK(store.Stats().accepted == 2, "accepted count");
    CHECK(store.Stats().current_graph_revision == 1, "current graph revision");
    CHECK(store.Stats().current_state_revision == 5, "current state revision");
    CHECK(store.Stats().layer_count == 1, "layer count");
    bg::ProtocolSnapshot stale;
    stale.graph_revision = 1;
    stale.state_revision = 4;
    CHECK(!store.Commit(std::move(stale)), "stale commit accepted");
    CHECK(store.Stats().stale_dropped == 1, "stale count");
    bg::ProtocolSnapshot new_graph;
    new_graph.graph_revision = 2;
    new_graph.state_revision = 0;
    CHECK(store.Commit(std::move(new_graph)), "new graph rejected");
}

TEST(StoreRecordsFailures) {
    bg::RenderGraphStore store;
    store.RecordMalformed("bad json");
    store.RecordBoundsViolation("layer count");
    store.RecordUnsupported("v2 header");
    CHECK(store.Stats().malformed == 1, "malformed count");
    CHECK(store.Stats().bounds_violations == 1, "bounds count");
    CHECK(store.Stats().unsupported == 1, "unsupported count");
    CHECK(!store.Stats().last_error_detail.empty(), "missing detail");
}

TEST(StoreResetAllowsBrowserRevisionRestart) {
    bg::RenderGraphStore store;
    bg::ProtocolSnapshot before_reload;
    before_reload.graph_revision = 9;
    before_reload.state_revision = 42;
    CHECK(store.Commit(std::move(before_reload)), "initial commit rejected");

    store.Reset();
    CHECK(!store.HasSnapshot(), "reset retained stale snapshot");
    CHECK(store.Stats().current_graph_revision == 0, "graph revision not reset");
    CHECK(store.Stats().current_state_revision == 0, "state revision not reset");
    CHECK(store.Stats().layer_count == 0, "layer count not reset");

    bg::ProtocolSnapshot after_reload;
    after_reload.graph_revision = 1;
    after_reload.state_revision = 0;
    CHECK(store.Commit(std::move(after_reload)),
          "browser revision restart rejected after reset");
}

int main() {
    const auto& tests = Registry();
    int run = 0;
    int passed = 0;
    for (const auto& t : tests) {
        std::printf("[ RUN      ] %s\n", t.name);
        const int before = g_failures;
        t.fn();
        ++run;
        if (g_failures == before) {
            ++passed;
            std::printf("[       OK ] %s\n", t.name);
        } else {
            std::printf("[   FAILED ] %s\n", t.name);
        }
    }
    std::printf("\n%d/%d tests passed, %d failed\n", passed, run, g_failures);
    return g_failures == 0 ? 0 : 1;
}
