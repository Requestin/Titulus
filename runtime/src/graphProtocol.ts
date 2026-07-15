// runtime/src/graphProtocol.ts
//
// Encoder for the bounded layer protocol v1 wire format consumed by the
// engine shadow RenderGraphStore (see engine/src/mixer/protocol_types.h).
//
// This module produces a `BGGRAPH v1 <json>` string from a `RenderGraphAnalysis`
// plus a `LayerLayoutResolver` that supplies live layout/mask/opacity values
// for each layer id. The engine never reads back; this is a one-way publish.
//
// Bounds (mirror engine/src/mixer/protocol_limits.h): encoder clamps/rejects
// values exceeding protocol limits and returns null instead of a malformed
// line. Callers must treat null as "no snapshot this frame".

import type { RenderGraphAnalysis, LayerGraphNode } from './layerPromote.js';

export const PROTOCOL_HEADER = 'BGGRAPH v1';
export const PROTOCOL_VERSION = 1;

export const PROTOCOL_MAX_LAYERS = 64;
export const PROTOCOL_MAX_DIRTY_DOMAINS = 4;
export const PROTOCOL_MAX_UNSUPPORTED_REASONS = 8;
export const PROTOCOL_MAX_LAYER_ID_BYTES = 128;
export const PROTOCOL_MAX_SNAPSHOT_JSON_BYTES = 64 * 1024;
export const PROTOCOL_MAX_LAYER_EXTENT = 8192;

export type ProtocolMaskMode = 'none' | 'normal' | 'inverted';

export interface ProtocolLayerLayout {
  /** Canvas-space top-left in pixels. */
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  anchor_x: number;
  anchor_y: number;
  source_w: number;
  source_h: number;
  opacity: number;
  mask_mode: ProtocolMaskMode;
  /** Mask rectangle in canvas space. Required when mask_mode !== 'none'. */
  mask_rect?: { x: number; y: number; w: number; h: number };
}

export type LayerLayoutResolver = (layerId: string) => ProtocolLayerLayout | null;

export interface GraphSnapshotInput {
  revision: number;
  analysis: RenderGraphAnalysis;
  resolveLayout: LayerLayoutResolver;
}

const DIRTY_DOMAIN_ORDER: ReadonlyArray<'content_dirty' | 'props_dirty' | 'mask_dirty'> = [
  'content_dirty',
  'props_dirty',
  'mask_dirty',
];

const UNSUPPORTED_REASON_LABELS: Record<string, string> = {
  fractional_rotation: 'fractional_rotation',
  non_positive_scale: 'non_positive_scale',
  non_rect_mask_shape: 'non_rect_mask_shape',
  oversized_layer: 'oversized_layer',
  three_d_transform: 'three_d_transform',
  non_normal_blend: 'non_normal_blend',
};

function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; ++i) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

function escapeJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; ++i) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x2f) out += '\\/';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else out += s[i];
  }
  return out + '"';
}

function escapeStringArray(items: readonly string[]): string {
  return '[' + items.map((s) => escapeJsonString(s)).join(',') + ']';
}

function appendNumber(out: string, n: number): string {
  if (!Number.isFinite(n)) return out + '0';
  if (Number.isInteger(n)) return out + n.toString();
  // Trim trailing zeros to keep the payload small.
  return out + parseFloat(n.toFixed(6)).toString();
}

function inExtent(v: number): boolean {
  return v >= -PROTOCOL_MAX_LAYER_EXTENT && v <= PROTOCOL_MAX_LAYER_EXTENT;
}

function clampDirty(node: LayerGraphNode): readonly string[] {
  const out: string[] = [];
  for (const candidate of DIRTY_DOMAIN_ORDER) {
    if (node.dirtyDomains.includes(candidate)) {
      out.push(candidate);
      if (out.length >= PROTOCOL_MAX_DIRTY_DOMAINS) break;
    }
  }
  return out;
}

function clampUnsupported(node: LayerGraphNode): readonly string[] {
  const out: string[] = [];
  for (const reason of node.operatorSupport.reasons) {
    const label = UNSUPPORTED_REASON_LABELS[reason];
    if (!label) continue;
    out.push(label);
    if (out.length >= PROTOCOL_MAX_UNSUPPORTED_REASONS) break;
  }
  return out;
}

function appendLayer(
  out: string,
  id: string,
  node: LayerGraphNode,
  layout: ProtocolLayerLayout,
): string {
  let s = out;
  if (s.length > 1) s += ',';
  s += '{';
  s += '"id":' + escapeJsonString(id);
  s += ',"kind":"' + node.nodeKind + '"';
  s += ',"dirty":' + escapeStringArray(clampDirty(node));
  s += ',"unsupported":' + escapeStringArray(clampUnsupported(node));
  s += ',"opacity":';
  s = appendNumber(s, layout.opacity);
  s += ',"mask_mode":"' + layout.mask_mode + '"';
  if (layout.mask_mode !== 'none' && layout.mask_rect) {
    s += ',"rect":[';
    s += layout.mask_rect.x + ',' + layout.mask_rect.y + ',';
    s += layout.mask_rect.w + ',' + layout.mask_rect.h + ']';
  }
  s += ',"x":' + Math.round(layout.x);
  s += ',"y":' + Math.round(layout.y);
  s += ',"sx":';
  s = appendNumber(s, layout.scale_x);
  s += ',"sy":';
  s = appendNumber(s, layout.scale_y);
  s += ',"rot":';
  s = appendNumber(s, layout.rotation_deg);
  s += ',"ax":';
  s = appendNumber(s, layout.anchor_x);
  s += ',"ay":';
  s = appendNumber(s, layout.anchor_y);
  s += ',"sw":' + layout.source_w;
  s += ',"sh":' + layout.source_h;
  s += '}';
  return s;
}

/**
 * Encode a graph snapshot for the engine shadow store. Returns null when the
 * snapshot cannot be represented within the bounded protocol (too many layers,
 * oversized id, out-of-range extent, snapshot too large).
 */
export function encodeGraphSnapshot(input: GraphSnapshotInput): string | null {
  if (!Number.isInteger(input.revision) || input.revision < 0) return null;

  const layerIds = [
    ...input.analysis.pixelSourceLayerIds,
    ...input.analysis.maskOperatorLayerIds,
  ];
  if (layerIds.length === 0) {
    // An empty snapshot is valid: it lets the engine know the page is alive
    // even when there is no work yet (e.g. before the first template take).
  }
  if (layerIds.length > PROTOCOL_MAX_LAYERS) return null;

  let payload = '{"type":"snapshot","rev":' + input.revision + ',"layers":[';
  let layersJson = '';

  for (const id of layerIds) {
    if (utf8Bytes(id) > PROTOCOL_MAX_LAYER_ID_BYTES) return null;
    const node = input.analysis.layers[id];
    if (!node) continue;
    const layout = input.resolveLayout(id);
    if (!layout) continue;
    if (
      !inExtent(layout.x) ||
      !inExtent(layout.y) ||
      !inExtent(layout.scale_x) ||
      !inExtent(layout.scale_y) ||
      !inExtent(layout.rotation_deg) ||
      !inExtent(layout.anchor_x) ||
      !inExtent(layout.anchor_y) ||
      !inExtent(layout.source_w) ||
      !inExtent(layout.source_h)
    ) {
      return null;
    }
    layersJson = appendLayer(layersJson, id, node, layout);
  }
  payload += layersJson + ']}';

  if (payload.length > PROTOCOL_MAX_SNAPSHOT_JSON_BYTES) return null;
  return PROTOCOL_HEADER + ' ' + payload;
}
