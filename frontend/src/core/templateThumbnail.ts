// frontend/src/core/templateThumbnail.ts
//
// Template library thumbnails are generated server-side (mid-timeline Chromium
// capture → $TITULUS_DATA/thumbnails/{id}.jpg). Editor Save triggers regenerate.

import { api } from '@/core/api';

/** Mid-timeline thumbnail regenerate (best-effort). */
export async function uploadTemplateThumbnail(templateId: string): Promise<string | null> {
  try {
    const res = await api.templates.regenerateThumbnail(templateId);
    return res.thumbnailUrl;
  } catch (err) {
    console.warn('[thumbnail] regenerate failed', err);
    return null;
  }
}
