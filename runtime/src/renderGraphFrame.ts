import type { ProtocolLayerLayout } from './graphProtocol.js';
import type { RenderGraphAnalysis } from './layerPromote.js';
import type {
  AnimatableValues,
  Layer,
  Template,
  Transform,
} from './schema.js';
import type { TimelineSample } from './timeline.js';

type Matrix = [number, number, number, number, number, number];

const identity = (): Matrix => [1, 0, 0, 0, 1, 0];

function multiply(parent: Matrix, local: Matrix): Matrix {
  return [
    parent[0] * local[0] + parent[1] * local[3],
    parent[0] * local[1] + parent[1] * local[4],
    parent[0] * local[2] + parent[1] * local[5] + parent[2],
    parent[3] * local[0] + parent[4] * local[3],
    parent[3] * local[1] + parent[4] * local[4],
    parent[3] * local[2] + parent[4] * local[5] + parent[5],
  ];
}

function currentTransform(
  base: Transform,
  animated: AnimatableValues | undefined,
): Transform {
  return animated ? { ...base, ...animated } : base;
}

/**
 * Match `applyTransform(..., { compositePosition: true })`: x/y identify the
 * anchor pivot in parent space and the affine matrix maps source-local pixels
 * into that parent.
 */
function transformMatrix(transform: Transform): Matrix {
  const radians = transform.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const originX = transform.width * transform.anchorX;
  const originY = transform.height * transform.anchorY;
  const m00 = cos * transform.scaleX;
  const m01 = -sin * transform.scaleY;
  const m10 = sin * transform.scaleX;
  const m11 = cos * transform.scaleY;
  return [
    m00,
    m01,
    transform.x - m00 * originX - m01 * originY,
    m10,
    m11,
    transform.y - m10 * originX - m11 * originY,
  ];
}

function maskRect(
  matrix: Matrix,
  width: number,
  height: number,
): ProtocolLayerLayout['mask_rect'] {
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ] as const;
  const projected = corners.map(([x, y]) => [
    matrix[0] * x + matrix[1] * y + matrix[2],
    matrix[3] * x + matrix[4] * y + matrix[5],
  ]);
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  return {
    x: Math.round(Math.min(...xs)),
    y: Math.round(Math.min(...ys)),
    w: Math.round(Math.max(...xs) - Math.min(...xs)),
    h: Math.round(Math.max(...ys) - Math.min(...ys)),
  };
}

function maskMode(layer: Layer): ProtocolLayerLayout['mask_mode'] {
  if (layer.type !== 'mask') return 'none';
  return layer.maskMode === 'inverted' ? 'inverted' : 'normal';
}

/**
 * Resolve the current flattened 2D state for every graph node. Group
 * transforms are multiplied into each source matrix; masks remain explicit
 * canvas-space operators.
 */
export function buildProtocolFrameLayouts(
  template: Template,
  analysis: RenderGraphAnalysis,
  sample: TimelineSample,
): Record<string, ProtocolLayerLayout> {
  const groupById = new Map(template.groups.map((group) => [group.id, group]));
  const groupWorld = new Map<string, Matrix>();
  const groupVisibility = new Map<string, boolean>();
  const visiting = new Set<string>();

  const resolveGroup = (id: string): Matrix => {
    const cached = groupWorld.get(id);
    if (cached) return cached;
    const group = groupById.get(id);
    if (!group || visiting.has(id)) return identity();
    visiting.add(id);
    const parent = group.parentId ? resolveGroup(group.parentId) : identity();
    const local = transformMatrix(
      currentTransform(group.transform, sample.groups[id]),
    );
    const world = multiply(parent, local);
    visiting.delete(id);
    groupWorld.set(id, world);
    return world;
  };

  const resolveGroupVisibility = (id: string, seen = new Set<string>()): boolean => {
    const cached = groupVisibility.get(id);
    if (cached !== undefined) return cached;
    const group = groupById.get(id);
    if (!group || seen.has(id)) return false;
    const next = new Set(seen);
    next.add(id);
    const visible = group.visible
      && (!group.parentId || resolveGroupVisibility(group.parentId, next));
    groupVisibility.set(id, visible);
    return visible;
  };

  const layouts: Record<string, ProtocolLayerLayout> = {};
  for (const layer of template.layers) {
    if (!analysis.layers[layer.id]) continue;
    const transform = currentTransform(
      layer.transform,
      sample.layers[layer.id],
    );
    const parent = layer.groupId ? resolveGroup(layer.groupId) : identity();
    const affine = multiply(parent, transformMatrix(transform));
    const visible = layer.visible
      && (!layer.groupId || resolveGroupVisibility(layer.groupId));
    layouts[layer.id] = {
      x: Math.round(affine[2]),
      y: Math.round(affine[5]),
      scale_x: transform.scaleX,
      scale_y: transform.scaleY,
      rotation_deg: transform.rotation,
      anchor_x: transform.anchorX,
      anchor_y: transform.anchorY,
      source_w: Math.round(transform.width),
      source_h: Math.round(transform.height),
      opacity: visible ? (sample.layers[layer.id]?.opacity ?? layer.opacity) : 0,
      mask_mode: maskMode(layer),
      mask_rect: layer.type === 'mask'
        ? maskRect(affine, transform.width, transform.height)
        : undefined,
      affine,
    };
  }
  return layouts;
}
