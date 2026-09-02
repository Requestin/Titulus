import type { Template, Transform } from '@runtime';
import {
  affineFromTransform,
  ancestorMatrix,
  invertAffine,
  multiplyAffine,
  transformPoint,
  type AffineMatrix,
} from './transformMath';

export interface BoundsBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function unionBoxes(boxes: readonly BoundsBox[]): BoundsBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function descendantLayerIds(template: Template, groupId: string): string[] {
  const out: string[] = [];
  const walk = (id: string): void => {
    for (const entry of template.groupStacks[id] ?? []) {
      if (entry.kind === 'layer') out.push(entry.id);
      else walk(entry.id);
    }
  };
  walk(groupId);
  return out;
}

export function layerBoxInCanvas(
  transform: Transform,
  parentMatrix: AffineMatrix,
): BoundsBox {
  const world = multiplyAffine(parentMatrix, affineFromTransform(transform));
  const corners = [
    transformPoint(world, { x: 0, y: 0 }),
    transformPoint(world, { x: transform.width, y: 0 }),
    transformPoint(world, { x: transform.width, y: transform.height }),
    transformPoint(world, { x: 0, y: transform.height }),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

export function derivedGroupBox(
  template: Template,
  groupId: string,
  resolveLayer: (id: string) => Transform,
  resolveGroup: (id: string) => Transform,
): BoundsBox | null {
  const ids = descendantLayerIds(template, groupId);
  const boxes = ids.map((id) => {
    const layer = template.layers.find((item) => item.id === id);
    if (!layer) return null;
    return layerBoxInCanvas(
      resolveLayer(id),
      ancestorMatrix(template, layer.groupId, (group) => resolveGroup(group.id)),
    );
  }).filter((box): box is BoundsBox => box !== null);
  return unionBoxes(boxes);
}

/** Visual axis-center in the same space as `box` (canvas for overlay). */
export function groupVisualPivot(
  box: BoundsBox,
  anchorX: number,
  anchorY: number,
): { x: number; y: number } {
  return {
    x: box.x + box.width * anchorX,
    y: box.y + box.height * anchorY,
  };
}

/** Map a canvas-space AABB into a group's parent space. */
export function boxInParentSpace(box: BoundsBox, parentMatrix: AffineMatrix): BoundsBox {
  const inverse = invertAffine(parentMatrix);
  if (!inverse) return box;
  return unionBoxes([
    pointBox(transformPoint(inverse, { x: box.x, y: box.y })),
    pointBox(transformPoint(inverse, { x: box.x + box.width, y: box.y })),
    pointBox(transformPoint(inverse, { x: box.x + box.width, y: box.y + box.height })),
    pointBox(transformPoint(inverse, { x: box.x, y: box.y + box.height })),
  ]) ?? box;
}

function pointBox(point: { x: number; y: number }): BoundsBox {
  return { x: point.x, y: point.y, width: 0, height: 0 };
}

/** Shift direct children so a group origin change does not move them on canvas. */
export function offsetDirectChildren(
  template: Template,
  groupId: string,
  dx: number,
  dy: number,
): void {
  if (dx === 0 && dy === 0) return;
  for (const entry of template.groupStacks[groupId] ?? []) {
    if (entry.kind === 'layer') {
      const layer = template.layers.find((item) => item.id === entry.id);
      if (!layer) continue;
      layer.transform.x += dx;
      layer.transform.y += dy;
      for (const keyframe of template.timeline.keyframes) {
        const bag = keyframe.layers[entry.id];
        if (!bag) continue;
        if (bag.x !== undefined) bag.x += dx;
        if (bag.y !== undefined) bag.y += dy;
      }
      continue;
    }
    const group = template.groups.find((item) => item.id === entry.id);
    if (!group) continue;
    group.transform.x += dx;
    group.transform.y += dy;
    for (const keyframe of template.timeline.keyframes) {
      const bag = keyframe.groups[entry.id];
      if (!bag) continue;
      if (bag.x !== undefined) bag.x += dx;
      if (bag.y !== undefined) bag.y += dy;
    }
  }
}
