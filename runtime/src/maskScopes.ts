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
 * Compute all mask scopes for a template. `rootStack` / `groupStacks` are stored
 * back-to-front (last entry is frontmost). A mask clips only siblings below it
 * in the visible tree, so it affects entries before the mask in the stack array.
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
            affected: entries.slice(0, i),
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
  const x = at.left;
  const y = at.top;
  const w = at.width;
  const h = at.height;
  if (mask.maskMode === 'normal') {
    if (mask.shape === 'ellipse') {
      return {
        overflow: 'hidden',
        clipPath: `ellipse(${w / 2}px ${h / 2}px at ${x + w / 2}px ${y + h / 2}px)`,
        borderRadius: '0',
      };
    }
    const right = Math.max(0, containerW - x - w);
    const bottom = Math.max(0, containerH - y - h);
    if (cr > 0) {
      return {
        overflow: 'hidden',
        clipPath: `inset(${y}px ${right}px ${bottom}px ${x}px round ${cr}px)`,
        borderRadius: '0',
      };
    }
    return {
      overflow: 'hidden',
      clipPath: `inset(${y}px ${right}px ${bottom}px ${x}px)`,
      borderRadius: '0',
    };
  }

  // Inverted: show outside mask rect via evenodd polygon on container bounds.
  if (mask.shape === 'ellipse') {
    // Approximate: outer canvas rect minus inner ellipse via SVG mask is heavy;
    // use polygon hole for rect bounds of ellipse for MVP.
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    const outer = `0px 0px, ${containerW}px 0px, ${containerW}px ${containerH}px, 0px ${containerH}px`;
    const inner = ellipsePolygon(cx, cy, rx, ry, 32);
    return {
      overflow: 'hidden',
      clipPath: `polygon(evenodd, ${outer}, ${inner})`,
      borderRadius: '0',
    };
  }
  const outer = `0px 0px, ${containerW}px 0px, ${containerW}px ${containerH}px, 0px ${containerH}px`;
  let inner: string;
  if (cr > 0) {
    inner = roundedRectPolygon(x, y, w, h, cr);
  } else {
    inner = `${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px`;
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
    pts.push(`${cx + Math.cos(a) * rx}px ${cy + Math.sin(a) * ry}px`);
  }
  return pts.join(', ');
}

/** Rounded-rect polygon (clockwise) for evenodd hole. */
function roundedRectPolygon(x: number, y: number, w: number, h: number, r: number): string {
  const cr = Math.min(r, w / 2, h / 2);
  if (cr <= 0) {
    return `${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px`;
  }
  // Simplified: 4 corners with quarter-circle approx (8 segments per corner = overkill; use 2 pts per corner)
  return [
    `${x + cr}px ${y}px`,
    `${x + w - cr}px ${y}px`,
    `${x + w}px ${y + cr}px`,
    `${x + w}px ${y + h - cr}px`,
    `${x + w - cr}px ${y + h}px`,
    `${x + cr}px ${y + h}px`,
    `${x}px ${y + h - cr}px`,
    `${x}px ${y + cr}px`,
  ].join(', ');
}
