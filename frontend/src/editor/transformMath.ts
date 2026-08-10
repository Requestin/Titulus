import type { LayerGroup, Template, Transform } from '@runtime';

export type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface Point {
  x: number;
  y: number;
}

/** CSS-compatible 2D affine matrix: x' = ax + cy + e; y' = bx + dy + f. */
export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY_MATRIX: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiplyAffine(left: AffineMatrix, right: AffineMatrix): AffineMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function transformPoint(matrix: AffineMatrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

export function transformVector(matrix: AffineMatrix, vector: Point): Point {
  return {
    x: matrix.a * vector.x + matrix.c * vector.y,
    y: matrix.b * vector.x + matrix.d * vector.y,
  };
}

export function invertAffine(matrix: AffineMatrix): AffineMatrix | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 1e-8) return null;
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

/**
 * The 2D subset of runtime applyTransform. x/y represent the anchor point;
 * 2.5D tilt is deliberately left to the runtime DOM renderer and has no
 * invertible affine screen-space equivalent.
 */
export function affineFromTransform(transform: Transform): AffineMatrix {
  const radians = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const a = cos * transform.scaleX;
  const b = sin * transform.scaleX;
  const c = -sin * transform.scaleY;
  const d = cos * transform.scaleY;
  const anchorX = transform.width * transform.anchorX;
  const anchorY = transform.height * transform.anchorY;
  return {
    a,
    b,
    c,
    d,
    e: transform.x - a * anchorX - c * anchorY,
    f: transform.y - b * anchorX - d * anchorY,
  };
}

export function ancestorMatrix(
  template: Template,
  parentId: string | null,
  resolveTransform: (group: LayerGroup) => Transform = (group) => group.transform,
): AffineMatrix {
  const ancestors: LayerGroup[] = [];
  const visited = new Set<string>();
  let groupId = parentId;
  while (groupId && !visited.has(groupId)) {
    visited.add(groupId);
    const group = template.groups.find((item) => item.id === groupId);
    if (!group) break;
    ancestors.unshift(group);
    groupId = group.parentId;
  }
  return ancestors.reduce(
    (matrix, group) => multiplyAffine(matrix, affineFromTransform(resolveTransform(group))),
    IDENTITY_MATRIX,
  );
}

/** Convert a canvas-space pointer delta into the edited layer's parent space. */
export function canvasDeltaToParent(parentMatrix: AffineMatrix, canvasDelta: Point): Point {
  const inverse = invertAffine(parentMatrix);
  return inverse ? transformVector(inverse, canvasDelta) : { x: 0, y: 0 };
}

function clampEdgeDelta(
  startSize: number,
  startEdge: number,
  endEdge: number,
  minSize: number,
): { startEdge: number; endEdge: number; size: number } {
  const size = startSize + endEdge - startEdge;
  if (size >= minSize) return { startEdge, endEdge, size };
  if (endEdge !== 0) return { startEdge, endEdge: minSize - startSize + startEdge, size: minSize };
  return { startEdge: startSize - minSize + endEdge, endEdge, size: minSize };
}

/**
 * Apply a move or one of eight resize gestures in the layer's parent space.
 * Resize deltas are first converted into the layer's unrotated local axes, so
 * a rotated/scaled layer keeps its opposite edge fixed instead of jumping.
 */
export function dragTransform(
  mode: DragMode,
  start: Transform,
  parentDelta: Point,
  minSize = 8,
): Pick<Transform, 'x' | 'y' | 'width' | 'height'> {
  if (mode === 'move') {
    return {
      x: start.x + parentDelta.x,
      y: start.y + parentDelta.y,
      width: start.width,
      height: start.height,
    };
  }

  const layerMatrix = affineFromTransform({ ...start, x: 0, y: 0 });
  const inverseLayer = invertAffine(layerMatrix);
  const localDelta = inverseLayer ? transformVector(inverseLayer, parentDelta) : { x: 0, y: 0 };
  const width = clampEdgeDelta(
    start.width,
    mode.includes('w') ? localDelta.x : 0,
    mode.includes('e') ? localDelta.x : 0,
    minSize,
  );
  const height = clampEdgeDelta(
    start.height,
    mode.includes('n') ? localDelta.y : 0,
    mode.includes('s') ? localDelta.y : 0,
    minSize,
  );

  const startMatrix = affineFromTransform(start);
  const startTopLeft = transformPoint(startMatrix, { x: 0, y: 0 });
  const shiftedTopLeft = {
    x: startTopLeft.x + layerMatrix.a * width.startEdge + layerMatrix.c * height.startEdge,
    y: startTopLeft.y + layerMatrix.b * width.startEdge + layerMatrix.d * height.startEdge,
  };
  return {
    x: shiftedTopLeft.x + layerMatrix.a * (width.size * start.anchorX) + layerMatrix.c * (height.size * start.anchorY),
    y: shiftedTopLeft.y + layerMatrix.b * (width.size * start.anchorX) + layerMatrix.d * (height.size * start.anchorY),
    width: width.size,
    height: height.size,
  };
}

/**
 * Re-express an effective transform in another parent's local space. The
 * editor transform model has no skew, so this is exact for the supported
 * translate/rotate/scale hierarchy and preserves the closest representable
 * transform for a sheared matrix.
 */
export function reparentTransform(
  transform: Transform,
  newParentMatrix: AffineMatrix,
  oldParentMatrix: AffineMatrix = IDENTITY_MATRIX,
): Transform {
  const inverseParent = invertAffine(newParentMatrix);
  if (!inverseParent) return transform;
  const world = multiplyAffine(oldParentMatrix, affineFromTransform(transform));
  const local = multiplyAffine(inverseParent, world);
  const scaleX = Math.hypot(local.a, local.b);
  if (scaleX < 1e-8) return transform;
  const rotation = (Math.atan2(local.b, local.a) * 180) / Math.PI;
  const scaleY = (local.a * local.d - local.b * local.c) / scaleX;
  const anchorX = transform.width * transform.anchorX;
  const anchorY = transform.height * transform.anchorY;
  return {
    ...transform,
    x: local.e + local.a * anchorX + local.c * anchorY,
    y: local.f + local.b * anchorX + local.d * anchorY,
    rotation,
    scaleX,
    scaleY,
  };
}
