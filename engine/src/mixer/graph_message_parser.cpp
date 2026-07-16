// engine/src/mixer/graph_message_parser.cpp

#include "graph_message_parser.h"

#include "protocol_limits.h"

#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <sstream>
#include <string>
#include <unordered_set>

namespace bg {

namespace {

constexpr const char* kHeader = "BGGRAPH v1 ";

bool StartsWith(std::string_view s, std::string_view prefix) {
    return s.size() >= prefix.size()
        && std::memcmp(s.data(), prefix.data(), prefix.size()) == 0;
}

// Minimal JSON value reader for our wire subset: objects, arrays, strings,
// numbers, true/false. No scientific notation (we control the encoder).
class Reader {
  public:
    explicit Reader(std::string_view src) : src_(src) {}

    bool Ok() const { return ok_ && pos_ == src_.size(); }
    bool Failed() const { return !ok_; }
    bool Eof() const { return pos_ >= src_.size(); }
    std::string_view ErrorContext() const { return error_; }

    void SkipWs() {
        while (pos_ < src_.size()) {
            const char c = src_[pos_];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
                ++pos_;
            } else {
                break;
            }
        }
    }

    char Peek() {
        SkipWs();
        if (pos_ >= src_.size()) {
            Fail("eof");
            return '\0';
        }
        return src_[pos_];
    }

    bool Consume(char c) {
        if (Peek() != c) return false;
        ++pos_;
        return true;
    }

    void Expect(char c, const char* msg) {
        if (!Consume(c)) Fail(msg);
    }

    // Parses a JSON string into out. Returns false on syntax error. Handles
    // \" \\ \/ \b \f \n \r \t \uXXXX as UTF-8 (basic plane only).
    bool ReadString(std::string& out) {
        out.clear();
        if (Peek() != '"') {
            Fail("expected string");
            return false;
        }
        ++pos_;
        while (pos_ < src_.size()) {
            const char c = src_[pos_++];
            if (c == '"') return true;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (pos_ >= src_.size()) {
                Fail("trailing escape");
                return false;
            }
            const char esc = src_[pos_++];
            switch (esc) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    if (pos_ + 4 > src_.size()) {
                        Fail("trailing \\u");
                        return false;
                    }
                    int code = 0;
                    const auto digits = src_.substr(pos_, 4);
                    for (char d : digits) {
                        code <<= 4;
                        if (d >= '0' && d <= '9') code += d - '0';
                        else if (d >= 'a' && d <= 'f') code += 10 + (d - 'a');
                        else if (d >= 'A' && d <= 'F') code += 10 + (d - 'A');
                        else {
                            Fail("bad \\u digit");
                            return false;
                        }
                    }
                    pos_ += 4;
                    if (code < 0x80) {
                        out.push_back(static_cast<char>(code));
                    } else if (code < 0x800) {
                        out.push_back(static_cast<char>(0xC0 | (code >> 6)));
                        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                    } else {
                        out.push_back(static_cast<char>(0xE0 | (code >> 12)));
                        out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
                        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
                    }
                    break;
                }
                default:
                    Fail("unknown escape");
                    return false;
            }
        }
        Fail("unterminated string");
        return false;
    }

    bool ReadNumber(double& out) {
        SkipWs();
        const size_t start = pos_;
        if (pos_ < src_.size() && (src_[pos_] == '-' || src_[pos_] == '+')) ++pos_;
        bool any = false;
        while (pos_ < src_.size()) {
            const char c = src_[pos_];
            if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E'
                || c == '-' || c == '+') {
                ++pos_;
                any = true;
            } else {
                break;
            }
        }
        if (!any) {
            Fail("empty number");
            return false;
        }
        const std::string tok(src_.substr(start, pos_ - start));
        try {
            size_t consumed = 0;
            out = std::stod(tok, &consumed);
            if (consumed != tok.size()) {
                Fail("partial number");
                return false;
            }
        } catch (...) {
            Fail("number parse");
            return false;
        }
        return true;
    }

    bool ReadBool(bool& out) {
        SkipWs();
        if (src_.compare(pos_, 4, "true") == 0) {
            pos_ += 4;
            out = true;
            return true;
        }
        if (src_.compare(pos_, 5, "false") == 0) {
            pos_ += 5;
            out = false;
            return true;
        }
        Fail("expected bool");
        return false;
    }

    void Fail(const char* msg) {
        if (ok_) {
            ok_ = false;
            error_ = msg;
        }
    }

  private:
    std::string_view src_;
    size_t pos_ = 0;
    bool ok_ = true;
    std::string_view error_;
};

bool ReadInt32(Reader& r, int32_t& out) {
    double v = 0;
    if (!r.ReadNumber(v)) return false;
    if (!std::isfinite(v) || std::trunc(v) != v
        || v < std::numeric_limits<int32_t>::min()
        || v > std::numeric_limits<int32_t>::max()) {
        r.Fail("int32 range");
        return false;
    }
    out = static_cast<int32_t>(v);
    return true;
}

bool ReadFloat(Reader& r, float& out) {
    double v = 0;
    if (!r.ReadNumber(v)) return false;
    if (!std::isfinite(v)
        || std::abs(v) > std::numeric_limits<float>::max()) {
        r.Fail("float range");
        return false;
    }
    out = static_cast<float>(v);
    return true;
}

bool ReadLayerNode(Reader& r, ProtocolLayerNode& node);

bool ReadRect(Reader& r, ProtocolLayerRect& out) {
    if (!r.Consume('[')) {
        r.Fail("rect array open");
        return false;
    }
    int32_t v[4] = {0, 0, 0, 0};
    for (int i = 0; i < 4; ++i) {
        if (!ReadInt32(r, v[i])) return false;
        if (i + 1 < 4 && !r.Consume(',')) {
            r.Fail("rect comma");
            return false;
        }
    }
    if (!r.Consume(']')) {
        r.Fail("rect array close");
        return false;
    }
    out.x = v[0];
    out.y = v[1];
    out.width = v[2];
    out.height = v[3];
    return true;
}

bool ReadAffine(Reader& r, float out[6]) {
    if (!r.Consume('[')) {
        r.Fail("affine array open");
        return false;
    }
    for (int i = 0; i < 6; ++i) {
        if (!ReadFloat(r, out[i])) return false;
        if (i + 1 < 6 && !r.Consume(',')) {
            r.Fail("affine comma");
            return false;
        }
    }
    if (!r.Consume(']')) {
        r.Fail("affine array close");
        return false;
    }
    return true;
}

bool ReadStringArray(Reader& r, std::vector<std::string>& out) {
    if (!r.Consume('[')) {
        r.Fail("array open");
        return false;
    }
    out.clear();
    r.SkipWs();
    if (r.Consume(']')) return true;
    for (;;) {
        std::string s;
        if (!r.ReadString(s)) return false;
        out.push_back(std::move(s));
        r.SkipWs();
        if (r.Consume(',')) continue;
        if (r.Consume(']')) return true;
        r.Fail("array separator");
        return false;
    }
}

bool ReadLayerNode(Reader& r, ProtocolLayerNode& node) {
    if (!r.Consume('{')) {
        r.Fail("layer open");
        return false;
    }
    bool seen_id = false;
    bool seen_kind = false;
    std::unordered_set<std::string> seen_keys;
    r.SkipWs();
    if (r.Consume('}')) {
        r.Fail("empty layer");
        return false;
    }
    for (;;) {
        std::string key;
        if (!r.ReadString(key)) return false;
        if (!seen_keys.insert(key).second) {
            r.Fail("duplicate layer key");
            return false;
        }
        if (!r.Consume(':')) {
            r.Fail("layer colon");
            return false;
        }
        if (key == "id") {
            if (!r.ReadString(node.id)) return false;
            seen_id = true;
        } else if (key == "kind") {
            std::string s;
            if (!r.ReadString(s)) return false;
            if (s == "cached_bitmap") {
                node.kind = ProtocolNodeKind::CachedBitmap;
            } else if (s == "live_html") {
                node.kind = ProtocolNodeKind::LiveHtml;
            } else if (s == "mask_operator") {
                node.kind = ProtocolNodeKind::MaskOperator;
            } else {
                r.Fail("unknown kind");
                return false;
            }
            seen_kind = true;
        } else if (key == "dirty") {
            std::vector<std::string> items;
            if (!ReadStringArray(r, items)) return false;
            node.dirty.clear();
            for (const auto& s : items) {
                if (s == "content_dirty")
                    node.dirty.push_back(ProtocolDirtyDomain::ContentDirty);
                else if (s == "props_dirty")
                    node.dirty.push_back(ProtocolDirtyDomain::PropsDirty);
                else if (s == "mask_dirty")
                    node.dirty.push_back(ProtocolDirtyDomain::MaskDirty);
                else {
                    r.Fail("unknown dirty");
                    return false;
                }
            }
        } else if (key == "opacity") {
            if (!ReadFloat(r, node.opacity)) return false;
        } else if (key == "mask_mode") {
            std::string s;
            if (!r.ReadString(s)) return false;
            if (s == "none") node.mask_mode = ProtocolMaskMode::None;
            else if (s == "normal") node.mask_mode = ProtocolMaskMode::Normal;
            else if (s == "inverted") node.mask_mode = ProtocolMaskMode::Inverted;
            else {
                r.Fail("unknown mask_mode");
                return false;
            }
        } else if (key == "rect") {
            if (!ReadRect(r, node.mask_rect)) return false;
        } else if (key == "affects") {
            if (!ReadStringArray(r, node.affected_source_ids)) return false;
        } else if (key == "m") {
            if (!ReadAffine(r, node.affine)) return false;
            node.has_affine = true;
        } else if (key == "x") {
            if (!ReadInt32(r, node.layout_position.x)) return false;
        } else if (key == "y") {
            if (!ReadInt32(r, node.layout_position.y)) return false;
        } else if (key == "sx") {
            if (!ReadFloat(r, node.scale_x)) return false;
        } else if (key == "sy") {
            if (!ReadFloat(r, node.scale_y)) return false;
        } else if (key == "rot") {
            if (!ReadFloat(r, node.rotation_deg)) return false;
        } else if (key == "ax") {
            if (!ReadFloat(r, node.anchor_x)) return false;
        } else if (key == "ay") {
            if (!ReadFloat(r, node.anchor_y)) return false;
        } else if (key == "sw") {
            if (!ReadInt32(r, node.source_w)) return false;
        } else if (key == "sh") {
            if (!ReadInt32(r, node.source_h)) return false;
        } else if (key == "unsupported") {
            std::vector<std::string> items;
            if (!ReadStringArray(r, items)) return false;
            node.unsupported.clear();
            for (const auto& s : items) {
                if (s == "fractional_rotation")
                    node.unsupported.push_back(ProtocolUnsupportedReason::FractionalRotation);
                else if (s == "non_positive_scale")
                    node.unsupported.push_back(ProtocolUnsupportedReason::NonPositiveScale);
                else if (s == "non_rect_mask_shape")
                    node.unsupported.push_back(ProtocolUnsupportedReason::NonRectMaskShape);
                else if (s == "oversized_layer")
                    node.unsupported.push_back(ProtocolUnsupportedReason::OversizedLayer);
                else if (s == "three_d_transform")
                    node.unsupported.push_back(ProtocolUnsupportedReason::ThreeDTransform);
                else if (s == "non_normal_blend")
                    node.unsupported.push_back(ProtocolUnsupportedReason::NonNormalBlend);
                else {
                    r.Fail("unknown unsupported");
                    return false;
                }
            }
        } else {
            r.Fail("unknown layer key");
            return false;
        }
        r.SkipWs();
        if (r.Consume(',')) continue;
        if (r.Consume('}')) break;
        r.Fail("layer separator");
        return false;
    }
    if (!seen_id) {
        r.Fail("missing id");
        return false;
    }
    if (!seen_kind) {
        r.Fail("missing kind");
        return false;
    }
    return true;
}

bool ReadLayerArray(Reader& r, std::vector<ProtocolLayerNode>& out) {
    if (!r.Consume('[')) {
        r.Fail("layers open");
        return false;
    }
    out.clear();
    r.SkipWs();
    if (r.Consume(']')) return true;
    for (;;) {
        ProtocolLayerNode node;
        if (!ReadLayerNode(r, node)) return false;
        out.push_back(std::move(node));
        r.SkipWs();
        if (r.Consume(',')) continue;
        if (r.Consume(']')) return true;
        r.Fail("layers separator");
        return false;
    }
}

bool ReadUint64(Reader& r, uint64_t& out) {
    double v = 0;
    if (!r.ReadNumber(v)) return false;
    // JSON numbers are emitted by JavaScript and are exact only through
    // Number.MAX_SAFE_INTEGER.
    constexpr double kMaxSafeInteger = 9007199254740991.0;
    if (!std::isfinite(v) || v < 0 || std::trunc(v) != v
        || v > kMaxSafeInteger) {
        r.Fail("invalid revision");
        return false;
    }
    out = static_cast<uint64_t>(v);
    return true;
}

bool CheckBounds(const ProtocolSnapshot& s, std::string& detail) {
    if (s.template_id.size() > protocol::kMaxTemplateIdBytes) {
        detail = "template id length";
        return false;
    }
    if (s.layers.size() > protocol::kMaxLayers) {
        detail = "layer count";
        return false;
    }
    std::unordered_set<std::string> ids;
    for (const auto& layer : s.layers) {
        if (layer.id.size() > protocol::kMaxLayerIdBytes) {
            detail = "layer id length";
            return false;
        }
        if (layer.id.empty() || !ids.insert(layer.id).second) {
            detail = "empty/duplicate layer id";
            return false;
        }
        if (layer.dirty.size() > protocol::kMaxDirtyDomainsPerLayer) {
            detail = "dirty domain count";
            return false;
        }
        if (layer.unsupported.size() > protocol::kMaxUnsupportedReasonsPerLayer) {
            detail = "unsupported reason count";
            return false;
        }
        if (layer.affected_source_ids.size()
            > protocol::kMaxAffectedSourcesPerMask) {
            detail = "affected source count";
            return false;
        }
        for (const auto& id : layer.affected_source_ids) {
            if (id.empty() || id.size() > protocol::kMaxLayerIdBytes) {
                detail = "affected source id length";
                return false;
            }
        }
        const auto extent_ok = [](int32_t v) {
            return v >= -protocol::kMaxLayerExtent
                && v <= protocol::kMaxLayerExtent;
        };
        if (!extent_ok(layer.layout_position.x) ||
            !extent_ok(layer.layout_position.y) ||
            !extent_ok(layer.mask_rect.x) ||
            !extent_ok(layer.mask_rect.y) ||
            !extent_ok(layer.mask_rect.width) ||
            !extent_ok(layer.mask_rect.height) ||
            !extent_ok(layer.source_w) ||
            !extent_ok(layer.source_h)) {
            detail = "extent";
            return false;
        }
        if (!std::isfinite(layer.opacity) || layer.opacity < 0.0f
            || layer.opacity > 1.0f || !std::isfinite(layer.scale_x)
            || !std::isfinite(layer.scale_y)
            || !std::isfinite(layer.rotation_deg)
            || !std::isfinite(layer.anchor_x)
            || !std::isfinite(layer.anchor_y)) {
            detail = "non-finite/range";
            return false;
        }
        if (layer.kind != ProtocolNodeKind::MaskOperator
            && (layer.source_w <= 0 || layer.source_h <= 0
                || layer.scale_x <= 0.0f || layer.scale_y <= 0.0f)) {
            detail = "source dimensions/scale";
            return false;
        }
        if (layer.has_affine) {
            for (const float coefficient : layer.affine) {
                if (!std::isfinite(coefficient)
                    || std::abs(coefficient) > protocol::kMaxLayerExtent) {
                    detail = "affine";
                    return false;
                }
            }
            const float det = layer.affine[0] * layer.affine[4]
                - layer.affine[1] * layer.affine[3];
            if (!std::isfinite(det)
                || std::abs(det) <= std::numeric_limits<float>::epsilon()) {
                detail = "singular affine";
                return false;
            }
        }
    }
    if (s.invalidated_layer_ids.size() > protocol::kMaxLayers) {
        detail = "invalidate count";
        return false;
    }
    std::unordered_set<std::string> invalidated;
    for (const auto& id : s.invalidated_layer_ids) {
        if (id.empty() || id.size() > protocol::kMaxLayerIdBytes
            || !ids.contains(id) || !invalidated.insert(id).second) {
            detail = "invalid invalidate id";
            return false;
        }
    }
    for (const auto& layer : s.layers) {
        for (const auto& affected : layer.affected_source_ids) {
            if (!ids.contains(affected)) {
                detail = "unknown affected source";
                return false;
            }
        }
    }
    return true;
}

}  // namespace

GraphParseResult ParseGraphMessage(std::string_view line) {
    GraphParseResult res;
    if (!StartsWith(line, kHeader)) {
        res.status = GraphParseStatus::NotGraphMessage;
        return res;
    }
    std::string_view body = line.substr(std::string_view(kHeader).size());
    if (body.size() > protocol::kMaxSnapshotJsonBytes) {
        res.status = GraphParseStatus::BoundsViolation;
        res.error_detail = "snapshot too large";
        return res;
    }
    Reader r(body);
    if (!r.Consume('{')) {
        res.status = GraphParseStatus::MalformedJson;
        res.error_detail = "object open";
        return res;
    }
    bool seen_type = false;
    bool seen_graph_rev = false;
    bool seen_state_rev = false;
    bool seen_layers = false;
    std::unordered_set<std::string> seen_keys;
    ProtocolSnapshot snap;
    r.SkipWs();
    if (r.Consume('}')) {
        res.status = GraphParseStatus::MissingRequiredField;
        res.error_detail = "empty";
        return res;
    }
    for (;;) {
        std::string key;
        if (!r.ReadString(key)) {
            res.status = GraphParseStatus::MalformedJson;
            res.error_detail = "object key";
            return res;
        }
        if (!seen_keys.insert(key).second) {
            res.status = GraphParseStatus::MalformedJson;
            res.error_detail = "duplicate object key";
            return res;
        }
        if (!r.Consume(':')) {
            res.status = GraphParseStatus::MalformedJson;
            res.error_detail = "object colon";
            return res;
        }
        if (key == "type") {
            std::string s;
            if (!r.ReadString(s)) {
                res.status = GraphParseStatus::MalformedJson;
                res.error_detail = "type value";
                return res;
            }
            if (s != "snapshot") {
                res.status = GraphParseStatus::UnsupportedFieldValue;
                res.error_detail = "type";
                return res;
            }
            seen_type = true;
        } else if (key == "template_id") {
            if (!r.ReadString(snap.template_id)) {
                res.status = GraphParseStatus::MalformedJson;
                res.error_detail = "template_id";
                return res;
            }
        } else if (key == "graph_rev" || key == "rev") {
            if (seen_graph_rev
                || !ReadUint64(r, snap.graph_revision)) {
                res.status = GraphParseStatus::MalformedJson;
                res.error_detail = "graph_rev value/duplicate";
                return res;
            }
            seen_graph_rev = true;
        } else if (key == "state_rev") {
            if (seen_state_rev
                || !ReadUint64(r, snap.state_revision)) {
                res.status = GraphParseStatus::MalformedJson;
                res.error_detail = "state_rev value/duplicate";
                return res;
            }
            seen_state_rev = true;
        } else if (key == "invalidate") {
            if (!ReadStringArray(r, snap.invalidated_layer_ids)) {
                res.status = GraphParseStatus::MalformedJson;
                res.error_detail = "invalidate";
                return res;
            }
        } else if (key == "layers") {
            if (!ReadLayerArray(r, snap.layers)) {
                res.status = GraphParseStatus::MalformedJson;
                res.error_detail = std::string(r.ErrorContext());
                return res;
            }
            seen_layers = true;
        } else {
            res.status = GraphParseStatus::MalformedJson;
            res.error_detail = "unknown object key";
            return res;
        }
        r.SkipWs();
        if (r.Consume(',')) continue;
        if (r.Consume('}')) break;
        res.status = GraphParseStatus::MalformedJson;
        res.error_detail = "object separator";
        return res;
    }
    if (!r.Ok()) {
        res.status = GraphParseStatus::MalformedJson;
        res.error_detail = r.ErrorContext();
        return res;
    }
    if (!(seen_type && seen_graph_rev && seen_layers)) {
        res.status = GraphParseStatus::MissingRequiredField;
        res.error_detail = "type/graph_rev/layers";
        return res;
    }
    std::string detail;
    if (!CheckBounds(snap, detail)) {
        res.status = GraphParseStatus::BoundsViolation;
        res.error_detail = detail;
        return res;
    }
    res.status = GraphParseStatus::Ok;
    res.snapshot = std::move(snap);
    return res;
}

}  // namespace bg
