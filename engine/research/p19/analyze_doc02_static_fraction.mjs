#!/usr/bin/env node
/**
 * Operator-aware preflight classifier for the Doc02 layered compositor.
 *
 * A moving layer is not necessarily a changing pixel source. The classifier
 * therefore separates content, property and mask invalidation. It is read-only
 * research tooling; production runtime promotion is implemented separately.
 */

import fs from 'node:fs';
import path from 'node:path';

const PROP_KEYS = new Set([
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'rotationX',
  'rotationY',
  'perspective',
  'scaleX',
  'scaleY',
  'anchorX',
  'anchorY',
  'opacity',
  'visible',
  'z',
]);

function collectVariableIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectVariableIds(item, ids);
    return ids;
  }
  if (value.type === 'variable' && typeof value.variableId === 'string') {
    ids.add(value.variableId);
  }
  for (const child of Object.values(value)) collectVariableIds(child, ids);
  return ids;
}

function animatedProperties(template) {
  const layers = new Map();
  const groups = new Map();
  const add = (target, id, props) => {
    if (!target.has(id)) target.set(id, new Set());
    for (const prop of Object.keys(props ?? {})) target.get(id).add(prop);
  };
  for (const keyframe of template.timeline?.keyframes ?? []) {
    for (const [id, props] of Object.entries(keyframe.layers ?? {})) add(layers, id, props);
    for (const [id, props] of Object.entries(keyframe.groups ?? {})) add(groups, id, props);
  }
  return { layers, groups };
}

function descendants(entry, groupStacks) {
  if (entry.kind === 'layer') return [entry.id];
  return (groupStacks[entry.id] ?? []).flatMap((child) => descendants(child, groupStacks));
}

function entriesInScope(entries, groupStacks) {
  return entries.flatMap((entry) => descendants(entry, groupStacks));
}

function sourceArea(layer) {
  const width = Number(layer.transform?.width);
  const height = Number(layer.transform?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  return Math.max(0, width) * Math.max(0, height);
}

function unionArea(rects, canvas) {
  const xs = [...new Set(rects.flatMap((rect) => [
    Math.max(0, Math.min(canvas.width, rect.x)),
    Math.max(0, Math.min(canvas.width, rect.x + rect.width)),
  ]))].sort((a, b) => a - b);
  let area = 0;
  for (let index = 0; index < xs.length - 1; index += 1) {
    const left = xs[index];
    const right = xs[index + 1];
    if (right <= left) continue;
    const intervals = rects
      .filter((rect) => rect.x < right && rect.x + rect.width > left)
      .map((rect) => [
        Math.max(0, Math.min(canvas.height, rect.y)),
        Math.max(0, Math.min(canvas.height, rect.y + rect.height)),
      ])
      .filter(([top, bottom]) => bottom > top)
      .sort((a, b) => a[0] - b[0]);
    let top = -1;
    let bottom = -1;
    for (const [nextTop, nextBottom] of intervals) {
      if (nextTop > bottom) {
        area += Math.max(0, bottom - top) * (right - left);
        top = nextTop;
        bottom = nextBottom;
      } else {
        bottom = Math.max(bottom, nextBottom);
      }
    }
    area += Math.max(0, bottom - top) * (right - left);
  }
  return area;
}

function legacyTwoPlateAnalysis(template, layers, groupStacks, animation) {
  const dynamic = new Map();

  for (const layer of layers.values()) {
    if (layer.type === 'clock') dynamic.set(layer.id, 'clock');
    else if (layer.type === 'video') dynamic.set(layer.id, 'video');
    else if (animation.layers.has(layer.id)) dynamic.set(layer.id, 'animated_layer');
    else if (collectVariableIds(layer).size > 0) dynamic.set(layer.id, 'variable_binding');
  }

  for (const group of template.groups ?? []) {
    if (!animation.groups.has(group.id)) continue;
    for (const id of entriesInScope(groupStacks[group.id] ?? [], groupStacks)) {
      dynamic.set(id, `animated_group:${group.id}`);
    }
  }

  const scopes = [template.rootStack ?? [], ...Object.values(groupStacks)];
  for (const entries of scopes) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.kind !== 'layer' || layers.get(entry.id)?.type !== 'mask') continue;
      if (!dynamic.has(entry.id)) continue;
      for (const id of entriesInScope(entries.slice(0, index), groupStacks)) {
        dynamic.set(id, `dynamic_mask_scope:${entry.id}`);
      }
    }
  }

  const staticLayerIds = [];
  const dynamicLayerIds = [];
  const staticRects = [];
  for (const layer of template.layers ?? []) {
    if (dynamic.has(layer.id)) {
      dynamicLayerIds.push(layer.id);
    } else {
      staticLayerIds.push(layer.id);
      if (layer.transform?.width > 0 && layer.transform?.height > 0) {
        staticRects.push(layer.transform);
      }
    }
  }
  const canvas = template.canvas ?? { width: 0, height: 0 };
  const canvasArea = canvas.width * canvas.height;
  return {
    staticLayerIds,
    dynamicLayerIds,
    coverage: canvasArea > 0 ? unionArea(staticRects, canvas) / canvasArea : 0,
  };
}

function maskScopes(template, layers, groupStacks) {
  const affectedByMask = new Map();
  const scopes = [template.rootStack ?? [], ...Object.values(groupStacks)];
  for (const entries of scopes) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.kind !== 'layer' || layers.get(entry.id)?.type !== 'mask') continue;
      const affected = entriesInScope(entries.slice(0, index), groupStacks)
        .filter((id) => layers.get(id)?.type !== 'mask');
      affectedByMask.set(entry.id, affected);
    }
  }
  return affectedByMask;
}

function operatorSupport(layer, animatedProps) {
  const reasons = [];
  if (layer.blendMode && layer.blendMode !== 'normal') reasons.push(`blend_mode:${layer.blendMode}`);
  const transform = layer.transform ?? {};
  const has3dState = Number(transform.rotationX ?? 0) !== 0
    || Number(transform.rotationY ?? 0) !== 0;
  const has3dAnimation = animatedProps.includes('rotationX')
    || animatedProps.includes('rotationY')
    || animatedProps.includes('perspective');
  if (has3dState || has3dAnimation) reasons.push('3d_transform');
  if (layer.type === 'mask') {
    if ((layer.shape ?? 'rect') !== 'rect') reasons.push(`mask_shape:${layer.shape}`);
    if (Number(layer.cornerRadius ?? 0) !== 0) reasons.push('rounded_mask');
    if (Number(transform.rotation ?? 0) !== 0 || animatedProps.includes('rotation')) {
      reasons.push('rotated_mask');
    }
    if (!['normal', 'inverted'].includes(layer.maskMode ?? 'normal')) {
      reasons.push(`mask_mode:${layer.maskMode}`);
    }
  }
  return { supported: reasons.length === 0, reasons };
}

export function analyzeTemplate(template) {
  const layers = new Map((template.layers ?? []).map((layer) => [layer.id, layer]));
  const groupStacks = template.groupStacks ?? {};
  const animation = animatedProperties(template);
  const affectedByMask = maskScopes(template, layers, groupStacks);
  const animatedGroupsByLayer = new Map();
  for (const group of template.groups ?? []) {
    if (!animation.groups.has(group.id)) continue;
    for (const id of entriesInScope(groupStacks[group.id] ?? [], groupStacks)) {
      if (!animatedGroupsByLayer.has(id)) animatedGroupsByLayer.set(id, []);
      animatedGroupsByLayer.get(id).push(group.id);
    }
  }

  const groups = {};
  for (const group of template.groups ?? []) {
    const animatedProps = [...(animation.groups.get(group.id) ?? [])].sort();
    groups[group.id] = {
      animatedProps,
      dirtyDomains: animatedProps.length > 0 ? ['props_dirty'] : [],
    };
  }

  const pixelSourceLayerIds = [];
  const cacheableSourceLayerIds = [];
  const liveSourceLayerIds = [];
  const maskOperatorLayerIds = [];
  const reportLayers = {};
  let allSourceWork = 0;
  let cacheableSourceWork = 0;

  for (const layer of template.layers ?? []) {
    const animatedProps = [...(animation.layers.get(layer.id) ?? [])].sort();
    const support = operatorSupport(layer, animatedProps);
    if (layer.type === 'mask') {
      const dirtyDomains = animatedProps.length > 0 ? ['mask_dirty'] : [];
      maskOperatorLayerIds.push(layer.id);
      reportLayers[layer.id] = {
        nodeKind: 'mask_operator',
        cacheableSource: false,
        contentPolicy: 'not_applicable',
        dirtyDomains,
        animatedProps,
        affectedSourceLayerIds: affectedByMask.get(layer.id) ?? [],
        operatorSupport: support,
      };
      continue;
    }

    pixelSourceLayerIds.push(layer.id);
    const variableIds = [...collectVariableIds(layer)].sort();
    const propertyAnimation = animatedProps.filter((prop) => PROP_KEYS.has(prop));
    const contentAnimation = animatedProps.filter((prop) => !PROP_KEYS.has(prop));
    const animatedGroupIds = [...(animatedGroupsByLayer.get(layer.id) ?? [])].sort();
    const intrinsicallyLive = layer.type === 'clock' || layer.type === 'video';
    const contentPolicy = intrinsicallyLive || contentAnimation.length > 0
      ? 'per_frame'
      : variableIds.length > 0 ? 'on_update' : 'immutable';
    const cacheableSource = contentPolicy !== 'per_frame' && support.supported;
    const dirtyDomains = [];
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
    reportLayers[layer.id] = {
      nodeKind: cacheableSource ? 'cached_bitmap' : 'live_html',
      cacheableSource,
      contentPolicy,
      dirtyDomains,
      animatedProps,
      animatedGroupIds,
      variableIds,
      sourceArea: area,
      operatorSupport: support,
    };
  }

  const legacy = legacyTwoPlateAnalysis(template, layers, groupStacks, animation);
  return {
    analysisVersion: 2,
    pixelSourceLayerIds,
    cacheableSourceLayerIds,
    liveSourceLayerIds,
    maskOperatorLayerIds,
    opportunityScore: allSourceWork > 0 ? cacheableSourceWork / allSourceWork : 0,
    legacyTwoPlateStaticCoverage: legacy.coverage,
    staticLayerIds: legacy.staticLayerIds,
    dynamicLayerIds: legacy.dynamicLayerIds,
    staticCoverage: legacy.coverage,
    layers: reportLayers,
    groups,
    unsupportedLayerIds: Object.entries(reportLayers)
      .filter(([, layer]) => !layer.operatorSupport.supported)
      .map(([id]) => id),
  };
}

function main() {
  const [inputPath] = process.argv.slice(2);
  if (!inputPath) {
    console.error('usage: analyze_doc02_static_fraction.mjs TEMPLATE.json');
    return 2;
  }
  const resolved = path.resolve(inputPath);
  const report = analyzeTemplate(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  process.exitCode = main();
}
