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
      const weights = [f.weight ?? 'normal', 'normal', '400'];
      let loaded = false;
      for (const weight of weights) {
        const shorthand = `${weight} 64px "${f.family}"`;
        try {
          const faces = await docFonts.load(shorthand);
          if (faces.length > 0) {
            loaded = true;
            break;
          }
        } catch {
          // try next weight
        }
      }
      // Only cache successful loads — a miss (no @font-face yet) must retry
      // after the MAM manifest is injected/refreshed.
      if (loaded) ensured.add(k);
    }),
  );
}

/** Drop cached ensures so a later ensureFonts() retries (e.g. after MAM import). */
export function resetEnsuredFonts(): void {
  ensured.clear();
}

/**
 * Collect the distinct font families/weights used by a template's text/clock
 * layers, for a bulk ensureFonts() call before the first render.
 */
export function collectFonts(layers: { type: string; style?: { fontFamily: string; fontWeight?: string } }[]): FontSpec[] {
  const map = new Map<string, FontSpec>();
  for (const l of layers) {
    if ((l.type === 'text' || l.type === 'clock' || l.type === 'crawl') && l.style) {
      const k = `${l.style.fontFamily}|${l.style.fontWeight ?? 'normal'}`;
      if (!map.has(k)) map.set(k, { family: l.style.fontFamily, weight: l.style.fontWeight });
    }
  }
  return [...map.values()];
}
