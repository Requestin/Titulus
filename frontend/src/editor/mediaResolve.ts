import type { Template } from '@runtime';
import { api } from '@/core/api';

/** token (`asset:…`) → playback URL (`/uploads/…`). */
const urlByToken = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export function rememberMediaUrl(token: string, url: string | null | undefined): void {
  const key = String(token || '').trim();
  const value = String(url || '').trim();
  if (!key.startsWith('asset:') || !value) return;
  urlByToken.set(key, value);
}

export function mediaUrlFor(src: string): string {
  const raw = String(src || '').trim();
  if (!raw.startsWith('asset:')) return raw;
  return urlByToken.get(raw) ?? raw;
}

export function collectAssetTokens(template: Template | null | undefined): string[] {
  if (!template) return [];
  const out = new Set<string>();
  for (const layer of template.layers ?? []) {
    if ((layer.type === 'image' || layer.type === 'video') && typeof layer.src === 'string' && layer.src.startsWith('asset:')) {
      out.add(layer.src);
    }
    if (layer.type === 'crawl' && typeof layer.crawl?.separatorImage === 'string' && layer.crawl.separatorImage.startsWith('asset:')) {
      out.add(layer.crawl.separatorImage);
    }
  }
  for (const variable of template.variables ?? []) {
    if ((variable.type === 'image' || variable.type === 'video')
      && typeof variable.defaultValue === 'string'
      && variable.defaultValue.startsWith('asset:')) {
      out.add(variable.defaultValue);
    }
  }
  return [...out];
}

async function resolveOne(token: string): Promise<string | null> {
  const cached = urlByToken.get(token);
  if (cached) return cached;
  const pending = inflight.get(token);
  if (pending) return pending;
  const job = api.media.resolve(token)
    .then((asset) => {
      const url = asset.url || asset.posterUrl || null;
      if (url) rememberMediaUrl(token, url);
      return url;
    })
    .catch(() => null)
    .finally(() => { inflight.delete(token); });
  inflight.set(token, job);
  return job;
}

/** Fetch any missing asset: URLs. Returns true if the cache gained entries. */
export async function ensureMediaResolved(tokens: string[]): Promise<boolean> {
  const missing = tokens.filter((token) => token.startsWith('asset:') && !urlByToken.has(token));
  if (missing.length === 0) return false;
  const before = urlByToken.size;
  await Promise.all(missing.map((token) => resolveOne(token)));
  return urlByToken.size > before;
}

function rewriteSrc(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('asset:')) return value;
  return mediaUrlFor(value);
}

/** Shallow-clone template with asset: tokens replaced by cached URLs where known. */
export function resolveTemplateMedia(template: Template): Template {
  const next = structuredClone(template);
  for (const layer of next.layers ?? []) {
    if (layer.type === 'image' || layer.type === 'video') {
      layer.src = rewriteSrc(layer.src) as typeof layer.src;
    }
    if (layer.type === 'crawl' && layer.crawl && typeof layer.crawl.separatorImage === 'string') {
      layer.crawl.separatorImage = mediaUrlFor(layer.crawl.separatorImage);
    }
  }
  for (const variable of next.variables ?? []) {
    if ((variable.type === 'image' || variable.type === 'video') && typeof variable.defaultValue === 'string') {
      variable.defaultValue = mediaUrlFor(variable.defaultValue);
    }
  }
  return next;
}
