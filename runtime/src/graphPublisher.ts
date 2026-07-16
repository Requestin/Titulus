// runtime/src/graphPublisher.ts
//
// Convenience wrapper around encodeGraphSnapshot for the channel.html path.
// Produces a BGGRAPH v1 console.log line from a Template + render-graph
// analysis. Default-off: only emit when the page URL opts in via
// ?graph=1 (or when window.BG_GRAPH_PUBLISH is set to 1). The engine shadow
// store is always attached, so emitting is free; the cost is only the encode
// pass which is bounded and runs at most once per take.

import {
  encodeGraphSnapshot,
  type LayerLayoutResolver,
  type ProtocolLayerLayout,
  type ProtocolMaskMode,
} from './graphProtocol.js';
import { classifyRenderGraph } from './layerPromote.js';
import type { Layer, MaskLayer, Template } from './schema.js';

function isMaskLayer(layer: Layer): layer is MaskLayer {
  return layer.type === 'mask';
}

function layerMaskMode(layer: Layer): ProtocolMaskMode {
  if (!isMaskLayer(layer)) return 'none';
  return layer.maskMode === 'inverted' ? 'inverted' : 'normal';
}

function layerMaskRect(layer: Layer): ProtocolLayerLayout['mask_rect'] {
  if (!isMaskLayer(layer)) return undefined;
  // MaskLayer has no dedicated rect field; the geometry is carried by
  // transform.x/y/width/height (the same convention domRenderer uses).
  return {
    x: Math.round(layer.transform.x),
    y: Math.round(layer.transform.y),
    w: Math.round(layer.transform.width),
    h: Math.round(layer.transform.height),
  };
}

function buildLayoutResolver(template: Template): LayerLayoutResolver {
  const byId = new Map<string, Layer>();
  for (const layer of template.layers ?? []) byId.set(layer.id, layer);
  return (layerId): ProtocolLayerLayout | null => {
    const layer = byId.get(layerId);
    if (!layer) return null;
    const transform = layer.transform;
    const radians = transform.rotation * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const originX = transform.width * transform.anchorX;
    const originY = transform.height * transform.anchorY;
    const m00 = cos * transform.scaleX;
    const m01 = -sin * transform.scaleY;
    const m10 = sin * transform.scaleX;
    const m11 = cos * transform.scaleY;
    const left = transform.x - originX;
    const top = transform.y - originY;
    return {
      x: Math.round(left),
      y: Math.round(top),
      scale_x: transform.scaleX,
      scale_y: transform.scaleY,
      rotation_deg: transform.rotation,
      anchor_x: transform.anchorX,
      anchor_y: transform.anchorY,
      source_w: Math.round(transform.width),
      source_h: Math.round(transform.height),
      opacity: layer.opacity,
      mask_mode: layerMaskMode(layer),
      mask_rect: layerMaskRect(layer),
      affine: [
        m00,
        m01,
        left + originX - m00 * originX - m01 * originY,
        m10,
        m11,
        top + originY - m10 * originX - m11 * originY,
      ],
    };
  };
}

/**
 * Encode and publish a `BGGRAPH v1` snapshot for one template. Returns the
 * published line (without trailing newline) so the caller can log it however
 * it prefers, or null when the snapshot was rejected by the bounded encoder.
 *
 * Pass an existing analysis to avoid recomputing it (e.g. when the caller
 * already runs `classifyRenderGraph` for other reasons).
 */
export function publishTemplateGraph(
  template: Template,
  graphRevision: number,
  stateRevision: number,
  analysis?: ReturnType<typeof classifyRenderGraph>,
  resolveLayout?: LayerLayoutResolver,
  invalidatedLayerIds?: ReadonlyArray<string>,
): string | null {
  const graph = analysis ?? classifyRenderGraph(template);
  return encodeGraphSnapshot({
    templateId: template.id,
    graphRevision,
    stateRevision,
    invalidatedLayerIds,
    analysis: graph,
    resolveLayout: resolveLayout ?? buildLayoutResolver(template),
  });
}

/**
 * Returns true when graph publishing is opted in for this page. Inspects the
 * URL search params for `?graph=1` and the global `BG_GRAPH_PUBLISH` flag.
 */
export function isGraphPublishingEnabled(globalThis?: unknown): boolean {
  const g = globalThis as
    | { BG_GRAPH_PUBLISH?: unknown; location?: { search?: string } }
    | undefined;
  if (!g) return false;
  if (g.BG_GRAPH_PUBLISH === 1 || g.BG_GRAPH_PUBLISH === true) return true;
  try {
    const search = g.location?.search;
    if (!search) return false;
    const params = new URLSearchParams(search);
    return params.get('graph') === '1';
  } catch {
    return false;
  }
}
