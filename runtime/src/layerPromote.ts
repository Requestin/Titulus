// runtime/src/layerPromote.ts
//
// Pure projection from the authoring template to the operator-aware graph used
// by the layered-compositor protocol. This module classifies work only; it does
// not mutate the template or mount DOM.

import { computeMaskScopes } from './maskScopes.js';
import { ANIMATABLE_PROPS } from './schema.js';
import type {
  Layer,
  LayerGroup,
  RootStackEntry,
  Template,
} from './schema.js';

export type DirtyDomain = 'content_dirty' | 'props_dirty' | 'mask_dirty';
export type ContentPolicy = 'immutable' | 'on_update' | 'per_frame' | 'not_applicable';
export type RenderNodeKind = 'cached_bitmap' | 'live_html' | 'mask_operator';

export interface OperatorSupport {
  supported: boolean;
  reasons: string[];
}

export interface LayerGraphNode {
  nodeKind: RenderNodeKind;
  cacheableSource: boolean;
  contentPolicy: ContentPolicy;
  dirtyDomains: DirtyDomain[];
  animatedProps: string[];
  animatedGroupIds: string[];
  variableIds: string[];
  sourceArea: number;
  affectedSourceLayerIds?: string[];
  operatorSupport: OperatorSupport;
}

export interface GroupGraphNode {
  animatedProps: string[];
  dirtyDomains: DirtyDomain[];
  operatorSupport: OperatorSupport;
}

export interface RenderGraphStack {
  containerId: string | null;
  entries: RootStackEntry[];
}

export interface RenderGraphMaskScope {
  maskLayerId: string;
  containerId: string | null;
  affectedSourceLayerIds: string[];
}

export interface RenderGraphAnalysis {
  analysisVersion: 1;
  supported: boolean;
  fallbackReasons: string[];
  pixelSourceLayerIds: string[];
  cacheableSourceLayerIds: string[];
  liveSourceLayerIds: string[];
  maskOperatorLayerIds: string[];
  opportunityScore: number;
  layers: Record<string, LayerGraphNode>;
  groups: Record<string, GroupGraphNode>;
  stacks: RenderGraphStack[];
  maskScopes: RenderGraphMaskScope[];
  unsupportedLayerIds: string[];
  unsupportedGroupIds: string[];
}

interface AnimationMaps {
  layers: Map<string, Set<string>>;
  groups: Map<string, Set<string>>;
}

const PROPERTY_KEYS = new Set<string>([
  ...ANIMATABLE_PROPS,
  'anchorX',
  'anchorY',
  'visible',
  'z',
]);

function collectVariableIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectVariableIds(item, ids);
    return ids;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'variable' && typeof record.variableId === 'string') {
    ids.add(record.variableId);
  }
  for (const child of Object.values(record)) collectVariableIds(child, ids);
  return ids;
}

function animatedProperties(template: Template): AnimationMaps {
  const layers = new Map<string, Set<string>>();
  const groups = new Map<string, Set<string>>();
  const add = (target: Map<string, Set<string>>, id: string, props: object) => {
    const values = target.get(id) ?? new Set<string>();
    for (const prop of Object.keys(props)) values.add(prop);
    target.set(id, values);
  };
  for (const keyframe of template.timeline.keyframes) {
    for (const [id, props] of Object.entries(keyframe.layers)) add(layers, id, props);
    for (const [id, props] of Object.entries(keyframe.groups)) add(groups, id, props);
  }
  return { layers, groups };
}

function hasInvalidAnimatedScale(
  template: Template,
  id: string,
  target: 'layers' | 'groups',
): boolean {
  for (const keyframe of template.timeline.keyframes) {
    const props = keyframe[target][id];
    if (!props) continue;
    for (const value of [props.scaleX, props.scaleY]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        return true;
      }
    }
  }
  return false;
}

function expandEntries(
  entries: RootStackEntry[],
  groupStacks: Template['groupStacks'],
  seenGroups = new Set<string>(),
): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'layer') {
      result.push(entry.id);
      continue;
    }
    if (seenGroups.has(entry.id)) continue;
    const nextSeen = new Set(seenGroups);
    nextSeen.add(entry.id);
    result.push(...expandEntries(groupStacks[entry.id] ?? [], groupStacks, nextSeen));
  }
  return result;
}

function sourceArea(layer: Layer): number {
  const width = Number(layer.transform.width);
  const height = Number(layer.transform.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  return Math.max(0, width) * Math.max(0, height);
}

function layerOperatorSupport(
  layer: Layer,
  animatedProps: string[],
  invalidAnimatedScale: boolean,
): OperatorSupport {
  const reasons: string[] = [];
  if (layer.blendMode !== 'normal') reasons.push(`blend_mode:${layer.blendMode}`);
  if (!Number.isFinite(layer.transform.scaleX)
      || !Number.isFinite(layer.transform.scaleY)
      || layer.transform.scaleX <= 0 || layer.transform.scaleY <= 0
      || invalidAnimatedScale) {
    reasons.push('non_positive_scale');
  }
  const has3dState = layer.transform.rotationX !== 0 || layer.transform.rotationY !== 0;
  const has3dAnimation = animatedProps.includes('rotationX')
    || animatedProps.includes('rotationY')
    || animatedProps.includes('perspective');
  if (has3dState || has3dAnimation) reasons.push('3d_transform');

  if (layer.type === 'mask') {
    if (layer.shape !== 'rect') reasons.push(`mask_shape:${layer.shape}`);
    if (layer.cornerRadius !== 0) reasons.push('rounded_mask');
    if (layer.transform.rotation !== 0 || animatedProps.includes('rotation')) {
      reasons.push('rotated_mask');
    }
  } else if (animatedProps.includes('width') || animatedProps.includes('height')) {
    // Source extent changes alter text layout/object-fit/raster content. The
    // current cache protocol recaptures on update, not every timeline tick.
    reasons.push('animated_source_extent');
  }
  return { supported: reasons.length === 0, reasons };
}

function groupOperatorSupport(
  group: LayerGroup,
  animatedProps: string[],
  invalidAnimatedScale: boolean,
): OperatorSupport {
  const reasons: string[] = [];
  if (!Number.isFinite(group.transform.scaleX)
      || !Number.isFinite(group.transform.scaleY)
      || group.transform.scaleX <= 0 || group.transform.scaleY <= 0
      || invalidAnimatedScale) {
    reasons.push('non_positive_scale');
  }
  const has3dState = group.transform.rotationX !== 0 || group.transform.rotationY !== 0;
  const has3dAnimation = animatedProps.includes('rotationX')
    || animatedProps.includes('rotationY')
    || animatedProps.includes('perspective');
  if (has3dState || has3dAnimation) reasons.push('3d_transform');
  return { supported: reasons.length === 0, reasons };
}

function makeMaskScopes(
  template: Template,
  layerById: Map<string, Layer>,
): RenderGraphMaskScope[] {
  return computeMaskScopes(template).map((scope) => ({
    maskLayerId: scope.maskLayerId,
    containerId: scope.containerId,
    affectedSourceLayerIds: expandEntries(scope.affected, template.groupStacks)
      .filter((id) => layerById.get(id)?.type !== 'mask'),
  }));
}

/** Build the immutable operator-aware graph projection for one template. */
export function classifyRenderGraph(template: Template): RenderGraphAnalysis {
  const layerById = new Map(template.layers.map((layer) => [layer.id, layer]));
  const groupById = new Map(template.groups.map((group) => [group.id, group]));
  const animation = animatedProperties(template);
  const maskScopes = makeMaskScopes(template, layerById);
  const maskScopeById = new Map(maskScopes.map((scope) => [scope.maskLayerId, scope]));
  const animatedGroupsByLayer = new Map<string, string[]>();

  for (const group of template.groups) {
    if (!animation.groups.has(group.id)) continue;
    for (const layerId of expandEntries(template.groupStacks[group.id] ?? [], template.groupStacks)) {
      const groupIds = animatedGroupsByLayer.get(layerId) ?? [];
      groupIds.push(group.id);
      animatedGroupsByLayer.set(layerId, groupIds);
    }
  }

  const groups: Record<string, GroupGraphNode> = {};
  const unsupportedGroupIds: string[] = [];
  for (const group of template.groups) {
    const animatedProps = [...(animation.groups.get(group.id) ?? [])].sort();
    const operatorSupport = groupOperatorSupport(
      group,
      animatedProps,
      hasInvalidAnimatedScale(template, group.id, 'groups'),
    );
    if (!operatorSupport.supported) unsupportedGroupIds.push(group.id);
    groups[group.id] = {
      animatedProps,
      dirtyDomains: animatedProps.length > 0 ? ['props_dirty'] : [],
      operatorSupport,
    };
  }

  const layers: Record<string, LayerGraphNode> = {};
  const pixelSourceLayerIds: string[] = [];
  const cacheableSourceLayerIds: string[] = [];
  const liveSourceLayerIds: string[] = [];
  const maskOperatorLayerIds: string[] = [];
  const unsupportedLayerIds: string[] = [];
  let allSourceWork = 0;
  let cacheableSourceWork = 0;

  for (const layer of template.layers) {
    const animatedProps = [...(animation.layers.get(layer.id) ?? [])].sort();
    const operatorSupport = layerOperatorSupport(
      layer,
      animatedProps,
      hasInvalidAnimatedScale(template, layer.id, 'layers'),
    );
    if (layer.type === 'mask') {
      const seen = new Set<string>();
      let groupId = layer.groupId;
      while (groupId && !seen.has(groupId)) {
        seen.add(groupId);
        const group = groupById.get(groupId);
        if (!group) break;
        const groupAnimated = animation.groups.get(groupId);
        if (group.transform.rotation !== 0 || groupAnimated?.has('rotation')) {
          operatorSupport.reasons.push('rotated_mask_ancestor');
          operatorSupport.supported = false;
          break;
        }
        groupId = group.parentId;
      }
    }
    if (!operatorSupport.supported) unsupportedLayerIds.push(layer.id);

    if (layer.type === 'mask') {
      maskOperatorLayerIds.push(layer.id);
      layers[layer.id] = {
        nodeKind: 'mask_operator',
        cacheableSource: false,
        contentPolicy: 'not_applicable',
        dirtyDomains: animatedProps.length > 0 ? ['mask_dirty'] : [],
        animatedProps,
        animatedGroupIds: [],
        variableIds: [],
        sourceArea: 0,
        affectedSourceLayerIds: maskScopeById.get(layer.id)?.affectedSourceLayerIds ?? [],
        operatorSupport,
      };
      continue;
    }

    pixelSourceLayerIds.push(layer.id);
    const variableIds = [...collectVariableIds(layer)].sort();
    const propertyAnimation = animatedProps.filter((prop) => PROPERTY_KEYS.has(prop));
    const contentAnimation = animatedProps.filter((prop) => !PROPERTY_KEYS.has(prop));
    const animatedGroupIds = [...(animatedGroupsByLayer.get(layer.id) ?? [])].sort();
    const contentPolicy: ContentPolicy = layer.type === 'clock'
      || layer.type === 'video'
      || contentAnimation.length > 0
      ? 'per_frame'
      : variableIds.length > 0 ? 'on_update' : 'immutable';
    const cacheableSource = contentPolicy !== 'per_frame' && operatorSupport.supported;
    const dirtyDomains: DirtyDomain[] = [];
    if (contentPolicy !== 'immutable') dirtyDomains.push('content_dirty');
    if (propertyAnimation.length > 0 || animatedGroupIds.length > 0) {
      dirtyDomains.push('props_dirty');
    }
    const area = sourceArea(layer);
    allSourceWork += area;
    if (cacheableSource) {
      cacheableSourceLayerIds.push(layer.id);
      cacheableSourceWork += area;
    } else {
      liveSourceLayerIds.push(layer.id);
    }
    layers[layer.id] = {
      nodeKind: cacheableSource ? 'cached_bitmap' : 'live_html',
      cacheableSource,
      contentPolicy,
      dirtyDomains,
      animatedProps,
      animatedGroupIds,
      variableIds,
      sourceArea: area,
      operatorSupport,
    };
  }

  const fallbackReasons = [
    ...unsupportedLayerIds.flatMap((id) => (
      layers[id].operatorSupport.reasons.map((reason) => `layer:${id}:${reason}`)
    )),
    ...unsupportedGroupIds.flatMap((id) => (
      groups[id].operatorSupport.reasons.map((reason) => `group:${id}:${reason}`)
    )),
  ];
  const stacks: RenderGraphStack[] = [
    { containerId: null, entries: template.rootStack.map((entry) => ({ ...entry })) },
    ...Object.entries(template.groupStacks).map(([containerId, entries]) => ({
      containerId,
      entries: entries.map((entry) => ({ ...entry })),
    })),
  ];

  return {
    analysisVersion: 1,
    supported: fallbackReasons.length === 0,
    fallbackReasons,
    pixelSourceLayerIds,
    cacheableSourceLayerIds,
    liveSourceLayerIds,
    maskOperatorLayerIds,
    opportunityScore: allSourceWork > 0 ? cacheableSourceWork / allSourceWork : 0,
    layers,
    groups,
    stacks,
    maskScopes,
    unsupportedLayerIds,
    unsupportedGroupIds,
  };
}
