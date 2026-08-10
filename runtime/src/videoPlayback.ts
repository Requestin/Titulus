export type VideoPlaybackElementKind = 'video' | 'image';

/**
 * Alpha playback derivatives use animated WebP to avoid Chromium's expensive
 * WebM-alpha video path. Query strings are allowed for future cache busting.
 */
export function videoPlaybackElementKind(src: string): VideoPlaybackElementKind {
  const path = src.split(/[?#]/, 1)[0].toLowerCase();
  return path.endsWith('.webp') ? 'image' : 'video';
}
