import type { Template, Transform } from '@runtime';
import {
  affineFromTransform,
  ancestorMatrix,
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

function layerBoxInCanvas(
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
