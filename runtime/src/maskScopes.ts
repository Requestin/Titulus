// runtime/src/maskScopes.ts
//
// Stack-scoped mask semantics (маска.txt, DEVELOPMENT_PROMPT §6.5).
// A mask layer clips only siblings below it within the same stack container
// (rootStack or groupStacks[gid]). Nested groups below the mask are included.

import type { Template, RootStackEntry } from './schema.js';
import type { AppliedTransform } from './transform.js';

/** One mask scope within a single stack container. */
export interface MaskScope {
  maskLayerId: string;
  /** null = root stack; otherwise the group id owning this stack. */
  containerId: string | null;
  /** Stack entries below the mask (layers and groups), in paint order. */
  affected: RootStackEntry[];
}

/**
 * Compute all mask scopes for a template. Walks each stack container in order;
 * when a mask layer is encountered, all subsequent entries in that container
 * form one scope.
 */
export function computeMaskScopes(
  template: Pick<Template, 'layers' | 'rootStack' | 'groupStacks'>,
): MaskScope[] {
  const layerById = new Map(template.layers.map((l) => [l.id, l]));
  const scopes: MaskScope[] = [];

  const walkContainer = (containerId: string | null, entries: RootStackEntry[] | undefined) => {
    if (!entries) return;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.kind === 'layer') {
        const layer = layerById.get(e.id);
        if (layer?.type === 'mask') {
          scopes.push({
            maskLayerId: e.id,
            containerId,
            affected: entries.slice(i + 1),
          });
        }
      }
    }
  };

  walkContainer(null, template.rootStack);
  for (const [gid, entries] of Object.entries(template.groupStacks)) {
    walkContainer(gid, entries);
  }
  return scopes;
}

/** Map entry id -> innermost mask scope that affects it (if any). */
export function buildScopeMembership(
  scopes: MaskScope[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const scope of scopes) {
    for (const e of scope.affected) {
      // Later scopes in the same branch override (innermost mask wins for mount).
      out.set(e.id, scope.maskLayerId);
    }
  }
  return out;
}

/** Whether a layer has non-zero Z rotation (2D rotated mask — T2 path). */
export function hasZRotation(at: AppliedTransform, baseRotation: number): boolean {
  const rot = at.transform.includes('rotate(') && !at.transform.includes('rotateX');
  return rot && baseRotation !== 0;
}

/**
 * Build clip-path / overflow style for a 2D mask clip host (Phase 9.3 fast paths).
 * `at` is the mask's applied transform; coords are container-local.
 */
export function maskClipStyle(
  mask: {
    maskMode: 'normal' | 'inverted';
    shape: 'rect' | 'ellipse';
    cornerRadius: number;
  },
  at: AppliedTransform,
  containerW: number,
  containerH: number,
): { overflow: string; clipPath: string; borderRadius: string } {
  const cr = mask.cornerRadius;
  if (mask.maskMode === 'normal') {
    if (mask.shape === 'ellipse') {
      return {
        overflow: 'hidden',
        clipPath: 'none',
        borderRadius: '50%',
      };
    }
    if (cr > 0) {
      return {
        overflow: 'hidden',
        clipPath: `inset(0 round ${cr}px)`,
        borderRadius: '0',
      };
    }
    return { overflow: 'hidden', clipPath: 'none', borderRadius: '0' };
  }

  // Inverted: show outside mask rect via evenodd polygon on container bounds.
  const x = at.left;
  const y = at.top;
  const w = at.width;
  const h = at.height;
  if (mask.shape === 'ellipse') {
    // Approximate: outer canvas rect minus inner ellipse via SVG mask is heavy;
    // use polygon hole for rect bounds of ellipse for MVP.
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    const outer = `0 0, ${containerW} 0, ${containerW} ${containerH}, 0 ${containerH}`;
    const inner = ellipsePolygon(cx, cy, rx, ry, 32);
    return {
      overflow: 'hidden',
      clipPath: `polygon(evenodd, ${outer}, ${inner})`,
      borderRadius: '0',
    };
  }
  const outer = `0 0, ${containerW} 0, ${containerW} ${containerH}, 0 ${containerH}`;
  let inner: string;
  if (cr > 0) {
    inner = roundedRectPolygon(x, y, w, h, cr);
  } else {
    inner = `${x} ${y}, ${x + w} ${y}, ${x + w} ${y + h}, ${x} ${y + h}`;
  }
  return {
    overflow: 'hidden',
    clipPath: `polygon(evenodd, ${outer}, ${inner})`,
    borderRadius: '0',
  };
}

function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, segments: number): string {
  const pts: string[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(`${cx + Math.cos(a) * rx} ${cy + Math.sin(a) * ry}`);
  }
  return pts.join(', ');
}

/** Rounded-rect polygon (clockwise) for evenodd hole. */
function roundedRectPolygon(x: number, y: number, w: number, h: number, r: number): string {
  const cr = Math.min(r, w / 2, h / 2);
  if (cr <= 0) {
    return `${x} ${y}, ${x + w} ${y}, ${x + w} ${y + h}, ${x} ${y + h}`;
  }
  // Simplified: 4 corners with quarter-circle approx (8 segments per corner = overkill; use 2 pts per corner)
  return [
    `${x + cr} ${y}`,
    `${x + w - cr} ${y}`,
    `${x + w} ${y + cr}`,
    `${x + w} ${y + h - cr}`,
    `${x + w - cr} ${y + h}`,
    `${x + cr} ${y + h}`,
    `${x} ${y + h - cr}`,
    `${x} ${y + cr}`,
  ].join(', ');
}
