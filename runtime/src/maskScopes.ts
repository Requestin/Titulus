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
): {
  overflow: string;
  clipPath: string;
  borderRadius: string;
  maskImage: string;
  maskMode: string;
  maskSize: string;
  maskRepeat: string;
  maskPosition: string;
} {
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
        maskImage: 'none',
        maskMode: 'match-source',
        maskSize: 'auto',
        maskRepeat: 'repeat',
        maskPosition: '0 0',
      };
    }
    const right = Math.max(0, containerW - x - w);
    const bottom = Math.max(0, containerH - y - h);
    if (cr > 0) {
      return {
        overflow: 'hidden',
        clipPath: `inset(${y}px ${right}px ${bottom}px ${x}px round ${cr}px)`,
        borderRadius: '0',
        maskImage: 'none',
        maskMode: 'match-source',
        maskSize: 'auto',
        maskRepeat: 'repeat',
        maskPosition: '0 0',
      };
    }
    return {
      overflow: 'hidden',
      clipPath: `inset(${y}px ${right}px ${bottom}px ${x}px)`,
      borderRadius: '0',
      maskImage: 'none',
      maskMode: 'match-source',
      maskSize: 'auto',
      maskRepeat: 'repeat',
      maskPosition: '0 0',
    };
  }

  // Inverted axis-aligned rect with square corners: express "show everything
  // except this rect" as a single evenodd clip-path (outer container ring +
  // inner rect hole) instead of a full-canvas SVG luminance mask-image.
  // Phase 19 doc 01: the SVG mask-image path forces Skia to raster a
  // container-sized (e.g. 1920x1080) luminance layer every frame — on test1
  // this inverted band mask alone dropped the channel from 50 to ~41 fps.
  // clip-path polygon is a cheap geometric clip and is pixel-equivalent for a
  // hard-edged rectangular cutout. Rounded corners / ellipse keep the SVG
  // fallback (polygon can't round a hole without many segments).
  if (mask.shape === 'rect' && cr <= 0) {
    const right = x + w;
    const bottom = y + h;
    const outer = `0px 0px, ${containerW}px 0px, ${containerW}px ${containerH}px, 0px ${containerH}px`;
    const inner = `${x}px ${y}px, ${right}px ${y}px, ${right}px ${bottom}px, ${x}px ${bottom}px`;
    return {
      overflow: 'hidden',
      clipPath: `polygon(evenodd, ${outer}, ${inner})`,
      borderRadius: '0',
      maskImage: 'none',
      maskMode: 'match-source',
      maskSize: 'auto',
      maskRepeat: 'repeat',
      maskPosition: '0 0',
    };
  }

  const maskImage = invertedMaskImage(mask, x, y, w, h, containerW, containerH, cr);
  return {
    overflow: 'hidden',
    clipPath: 'none',
    borderRadius: '0',
    maskImage,
    maskMode: 'luminance',
    maskSize: `${containerW}px ${containerH}px`,
    maskRepeat: 'no-repeat',
    maskPosition: '0 0',
  };
}

function invertedMaskImage(
  mask: { shape: 'rect' | 'ellipse' },
  x: number,
  y: number,
  w: number,
  h: number,
  containerW: number,
  containerH: number,
  cornerRadius: number,
): string {
  const cutout = mask.shape === 'ellipse'
    ? `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="black"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(cornerRadius, w / 2, h / 2)}" ry="${Math.min(cornerRadius, w / 2, h / 2)}" fill="black"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${containerW}" height="${containerH}" viewBox="0 0 ${containerW} ${containerH}"><defs><mask id="m" maskUnits="userSpaceOnUse"><rect width="${containerW}" height="${containerH}" fill="white"/>${cutout}</mask></defs><rect width="${containerW}" height="${containerH}" fill="white" mask="url(#m)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
