#!/usr/bin/env node
/**
 * Conservative preflight classifier for the Doc02 layered-compositor bet.
 *
 * It intentionally over-classifies as dynamic: a false static layer can make
 * an on-air frame stale, while a false dynamic layer only reduces the estimated
 * opportunity. It does not change template rendering.
 */

import fs from 'node:fs';
import path from 'node:path';

function hasVariableBinding(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasVariableBinding);
  if (value.type === 'variable' && typeof value.variableId === 'string') return true;
  return Object.values(value).some(hasVariableBinding);
}

function animatedIds(template) {
  const ids = new Set(Object.keys(template.timeline?.trackDirectors ?? {}));
  for (const keyframe of template.timeline?.keyframes ?? []) {
    for (const id of Object.keys(keyframe.layers ?? {})) ids.add(id);
    for (const id of Object.keys(keyframe.groups ?? {})) ids.add(id);
  }
  return ids;
}

function descendants(entry, groupStacks) {
  if (entry.kind === 'layer') return [entry.id];
  return (groupStacks[entry.id] ?? []).flatMap((child) => descendants(child, groupStacks));
}

function entriesInScope(entries, groupStacks) {
  return entries.flatMap((entry) => descendants(entry, groupStacks));
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

export function analyzeTemplate(template) {
  const layers = new Map((template.layers ?? []).map((layer) => [layer.id, layer]));
  const groupStacks = template.groupStacks ?? {};
  const dynamic = new Map();
  const animated = animatedIds(template);

  for (const layer of layers.values()) {
    if (layer.type === 'clock') dynamic.set(layer.id, 'clock');
    else if (layer.type === 'video') dynamic.set(layer.id, 'video');
    else if (animated.has(layer.id)) dynamic.set(layer.id, 'animated_layer');
    else if (hasVariableBinding(layer)) dynamic.set(layer.id, 'variable_binding');
  }

  for (const group of template.groups ?? []) {
    if (!animated.has(group.id)) continue;
    for (const id of entriesInScope(groupStacks[group.id] ?? [], groupStacks)) {
      dynamic.set(id, `animated_group:${group.id}`);
    }
  }

  const scopes = [
    { entries: template.rootStack ?? [] },
    ...Object.values(groupStacks).map((entries) => ({ entries })),
  ];
  for (const { entries } of scopes) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.kind !== 'layer' || layers.get(entry.id)?.type !== 'mask') continue;
      if (!dynamic.has(entry.id)) continue;
      for (const id of entriesInScope(entries.slice(0, index), groupStacks)) {
        dynamic.set(id, `dynamic_mask_scope:${entry.id}`);
      }
    }
  }

  const reportLayers = {};
  const staticLayerIds = [];
  const dynamicLayerIds = [];
  const staticRects = [];
  for (const layer of template.layers ?? []) {
    const reason = dynamic.get(layer.id);
    if (reason) {
      dynamicLayerIds.push(layer.id);
      reportLayers[layer.id] = { classification: 'dynamic_html', reason };
      continue;
    }
    const classification = layer.type === 'rect' ? 'solid'
      : layer.type === 'image' ? 'static_image'
        : 'static_html';
    staticLayerIds.push(layer.id);
    reportLayers[layer.id] = { classification, reason: classification === 'static_image' ? 'immutable_image' : 'immutable_layer' };
    const rect = layer.transform;
    if (rect?.width > 0 && rect?.height > 0) staticRects.push(rect);
  }

  const canvas = template.canvas ?? { width: 0, height: 0 };
  const canvasArea = canvas.width * canvas.height;
  return {
    staticLayerIds,
    dynamicLayerIds,
    staticCoverage: canvasArea > 0 ? unionArea(staticRects, canvas) / canvasArea : 0,
    layers: reportLayers,
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
