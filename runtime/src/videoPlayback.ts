export type VideoPlaybackElementKind = 'video' | 'image';

/**
 * Alpha playback derivatives use animated WebP to avoid Chromium's expensive
 * WebM-alpha video path. Query strings are allowed for future cache busting.
 */
export function videoPlaybackElementKind(src: string): VideoPlaybackElementKind {
  const path = src.split(/[?#]/, 1)[0].toLowerCase();
  return path.endsWith('.webp') ? 'image' : 'video';
}

/** Visibility window in template frames. Missing bounds stay open. */
export function videoWindowOpen(
  layer: { type?: string; inFrame?: number; outFrame?: number },
  frame: number,
): boolean {
  if (layer.type !== 'video') return true;
  const start = layer.inFrame ?? 0;
  if (frame < start) return false;
  if (layer.outFrame == null) return true;
  return frame < layer.outFrame;
}
