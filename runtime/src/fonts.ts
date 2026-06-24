// runtime/src/fonts.ts
//
// Font loading for text layers (DEVELOPMENT_PROMPT §6.2: Google fonts via
// document.fonts.load). The engine channel page serves a bundled font manifest;
// the editor can mount arbitrary project fonts. Both call ensureFonts() before
// (re)syncing a template so text measures correctly.
//
// No DOM is built here — this only calls the CSS Font Loading API and returns
// when all requested families are ready (or fail). The renderer re-syncs after
// load so layout picks up the real metrics.

export interface FontSpec {
  family: string;
  /** CSS font-weight string e.g. "400", "700", "normal". */
  weight?: string;
}

/** Families the renderer has already ensured this session (avoid re-fetching). */
const ensured = new Set<string>();

function key(f: FontSpec): string {
  return `${f.family}|${f.weight ?? 'normal'}`;
}

/**
 * Ensure the given fonts are loaded via the CSS Font Loading API. Resolves once
 * all loads have settled (success or failure). Safe to call with duplicates.
 * No-op outside a DOM environment (e.g. SSR / unit tests).
 */
export async function ensureFonts(fonts: FontSpec[]): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  const docFonts = (document as Document).fonts;
  await Promise.all(
    fonts.map(async (f) => {
      const k = key(f);
      if (ensured.has(k)) return;
      // document.fonts.load expects a CSS font shorthand: "<weight> <size> <family>".
      const shorthand = `${f.weight ?? 'normal'} 64px "${f.family}"`;
      try {
        await docFonts.load(shorthand);
      } catch {
        // Family may not be available; the layer will fall back to a system font.
      }
      ensured.add(k);
    }),
  );
}

/**
 * Collect the distinct font families/weights used by a template's text/clock
 * layers, for a bulk ensureFonts() call before the first render.
 */
export function collectFonts(layers: { type: string; style?: { fontFamily: string; fontWeight?: string } }[]): FontSpec[] {
  const map = new Map<string, FontSpec>();
  for (const l of layers) {
    if ((l.type === 'text' || l.type === 'clock') && l.style) {
      const k = `${l.style.fontFamily}|${l.style.fontWeight ?? 'normal'}`;
      if (!map.has(k)) map.set(k, { family: l.style.fontFamily, weight: l.style.fontWeight });
    }
  }
  return [...map.values()];
}
