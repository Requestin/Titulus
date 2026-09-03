import {
  TemplateRenderer,
  collectFonts,
  ensureFonts,
  resolveCueFrame,
  resolveThumbnailFrame,
  resolveVariableMap,
  type Template,
} from '@runtime';
import {
  collectAssetTokens,
  ensureMediaResolved,
  resolveTemplateMedia,
} from './mediaResolve';

export function thumbnailLabel(name: string, max = 42): string {
  const trimmed = name.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function ensureXhtmlNamespace(serialized: string): string {
  if (serialized.includes('xmlns="http://www.w3.org/1999/xhtml"')) return serialized;
  return serialized.replace(/^\s*<([a-zA-Z][\w:-]*)/, '<$1 xmlns="http://www.w3.org/1999/xhtml"');
}

export function wrapForeignObjectSvg(xhtml: string, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`;
}

/** Public URL for a saved template thumbnail (served via /api/ so nginx /api proxy works). */
export function templateThumbnailUrl(templateId: string, cacheKey?: string): string {
  const base = `/api/templates/${encodeURIComponent(templateId)}/thumbnail`;
  if (!cacheKey) return base;
  return `${base}?v=${encodeURIComponent(cacheKey)}`;
}

export function renderNameCardJpeg(name: string, width = 320, height = 180): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas unsupported'));
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(0, 0, 8, height);
  ctx.fillStyle = '#e8eaed';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillText(thumbnailLabel(name), 24, height / 2);
  return canvasToJpeg(canvas);
}

export async function renderTemplateThumbnailJpeg(template: Template, width = 320, height = 180): Promise<Blob> {
  const target = resolveThumbnailTarget(template);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-12000px;top:0;pointer-events:none;';
  document.body.appendChild(host);
  const renderer = new TemplateRenderer(host, { playbackMode: 'raf' });
  try {
    await ensureMediaResolved(collectAssetTokens(template));
    const preview = resolveTemplateMedia(template);
    renderer.syncTemplate(preview, resolveVariableMap(preview), { reuseDirectors: false });
    await ensureFonts(collectFonts(preview.layers)).catch(() => undefined);
    if (document.fonts?.ready) await document.fonts.ready.catch(() => undefined);
    // A global seek samples every director whose time window is active. That
    // is wrong for thumbnails: an Update track can overwrite the default
    // preview at the same frame. Sample only the director that owns the
    // previewFrame tag.
    renderer.seekLocals({ [target.directorId]: target.frame });
    // syncTemplate schedules ensureFonts().then(applyState); flush before capture.
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
    renderer.seekLocals({ [target.directorId]: target.frame });
    await waitForPaint();
    await prepareMediaForCapture(renderer.getRoot());
    return captureElementJpeg(renderer.getRoot(), width, height);
  } finally {
    renderer.destroy();
    host.remove();
  }
}

function resolveThumbnailTarget(template: Template): { directorId: string; frame: number } {
  for (const cue of template.timeline.cues ?? []) {
    if (!cue.items.some((item) => item.command === 'tag' && item.parameterTag === 'previewFrame')) {
      continue;
    }
    const director = template.timeline.directors.find((item) => item.id === cue.directorId);
    return {
      directorId: cue.directorId,
      frame: resolveCueFrame(cue, director?.durationFrames ?? template.timeline.durationFrames),
    };
  }
  const fallbackDirector = template.timeline.directors.find((item) => item.id === 'default')
    ?? template.timeline.directors[0];
  return {
    directorId: fallbackDirector?.id ?? 'default',
    frame: resolveThumbnailFrame(template.timeline),
  };
}

async function waitForPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Wait for images/videos and inline them as data URIs so foreignObject SVG can paint them.
 *  External http(s)/blob URLs and nested data:image/svg+xml backgrounds do NOT load
 *  inside a data: SVG foreignObject — everything must become raster data URIs first. */
export async function prepareMediaForCapture(root: HTMLElement): Promise<void> {
  await rasterizeCssBackgrounds(root);

  const images = [...root.querySelectorAll('img')];
  await Promise.all(images.map(async (img) => {
    await waitForImage(img);
    const dataUrl = rasterElementToDataUrl(img);
    if (dataUrl) img.setAttribute('src', dataUrl);
  }));

  const videos = [...root.querySelectorAll('video')];
  await Promise.all(videos.map(async (video) => {
    await waitForVideoFrame(video);
    const snapshot = snapshotVideoAsImage(video);
    if (snapshot) video.replaceWith(snapshot);
  }));
}

/** Convert CSS background-image urls (gradients, etc.) into absolute image layers with PNG data URIs. */
async function rasterizeCssBackgrounds(root: HTMLElement): Promise<void> {
  const elements = [root, ...root.querySelectorAll<HTMLElement>('*')];
  for (const el of elements) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.includes('url(')) continue;
    const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
    const url = match?.[1]?.trim();
    if (!url) continue;
    const dataUrl = await loadUrlAsPngDataUrl(url);
    if (!dataUrl) continue;
    const layer = document.createElement('img');
    layer.alt = '';
    layer.src = dataUrl;
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = [
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'pointer-events:none',
      'object-fit:fill',
    ].join(';');
    el.style.backgroundImage = 'none';
    if (!el.style.position || el.style.position === 'static') el.style.position = 'relative';
    el.insertBefore(layer, el.firstChild);
  }
}

function loadUrlAsPngDataUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, image.naturalWidth || 64);
        canvas.height = Math.max(1, image.naturalHeight || 64);
        const ctx = canvas.getContext('2d');
        if (!ctx) { finish(null); return; }
        ctx.drawImage(image, 0, 0);
        finish(canvas.toDataURL('image/png'));
      } catch {
        finish(null);
      }
    };
    image.onerror = () => finish(null);
    image.src = url;
    window.setTimeout(() => finish(null), 2000);
  });
}

function rasterElementToDataUrl(img: HTMLImageElement): string | null {
  if (!img.naturalWidth || !img.naturalHeight) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function waitForImage(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    window.setTimeout(done, 1500);
  });
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const onReady = () => {
      try {
        // Prefer an early frame so stills/WebP and short clips both show content.
        if (Number.isFinite(video.duration) && video.duration > 0) {
          const target = Math.min(0.1, Math.max(0, video.duration * 0.05));
          if (Math.abs(video.currentTime - target) > 0.01) {
            video.currentTime = target;
            video.addEventListener('seeked', finish, { once: true });
            window.setTimeout(finish, 800);
            return;
          }
        }
      } catch {
        // seek may fail for some sources; fall through
      }
      finish();
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', finish, { once: true });
    try { video.load(); } catch { /* ignore */ }
    window.setTimeout(finish, 2000);
  });
}

function snapshotVideoAsImage(video: HTMLVideoElement): HTMLImageElement | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/jpeg', 0.85);
    img.setAttribute('aria-hidden', 'true');
    img.style.cssText = video.getAttribute('style') || 'width:100%;height:100%;display:block;object-fit:cover';
    return img;
  } catch {
    return null;
  }
}

async function captureElementJpeg(el: HTMLElement, outW: number, outH: number): Promise<Blob> {
  const sourceW = Math.max(1, el.offsetWidth || Number.parseInt(el.style.width, 10) || 1920);
  const sourceH = Math.max(1, el.offsetHeight || Number.parseInt(el.style.height, 10) || 1080);
  const clone = prepareCaptureClone(el);
  const xhtml = ensureXhtmlNamespace(new XMLSerializer().serializeToString(clone));
  const svg = wrapForeignObjectSvg(xhtml, sourceW, sourceH);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unsupported');
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(image, 0, 0, outW, outH);
  return canvasToJpeg(canvas);
}

const CAPTURE_STYLE_PROPS = [
  'display', 'visibility', 'opacity', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
  'transform', 'transform-origin', 'transform-style', 'perspective', 'backface-visibility',
  'background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height',
  'text-align', 'white-space', 'text-shadow', 'clip-path', 'border-radius', 'overflow', 'z-index',
  'mix-blend-mode', 'filter', 'box-shadow', 'padding', 'border', 'border-color', 'border-width', 'border-style',
] as const;

export function inlineCaptureStyles(source: HTMLElement, clone: HTMLElement): void {
  const computed = getComputedStyle(source);
  for (const prop of CAPTURE_STYLE_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value) clone.style.setProperty(prop, value);
  }
}

/** Data-URI CSS backgrounds (rect gradients) fail inside nested SVG foreignObject — flatten to an image layer. */
export function flattenDataUriBackgrounds(source: HTMLElement, clone: HTMLElement): void {
  const bgImage = getComputedStyle(source).backgroundImage;
  if (!bgImage || bgImage === 'none' || !bgImage.includes('data:')) return;
  const match = bgImage.match(/url\(["']?(data:[^"')]+)["']?\)/);
  const dataUri = match?.[1]?.trim();
  if (!dataUri) return;
  const layer = document.createElement('img');
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('src', dataUri);
  layer.style.cssText = [
    'position:absolute',
    'inset:0',
    'width:100%',
    'height:100%',
    'pointer-events:none',
    'object-fit:fill',
  ].join(';');
  clone.style.backgroundImage = 'none';
  if (!clone.style.position || clone.style.position === 'static') clone.style.position = 'relative';
  clone.insertBefore(layer, clone.firstChild);
}

function prepareCaptureClone(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  const sourceNodes = [el, ...el.querySelectorAll<HTMLElement>('*')];
  const cloneNodes = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  for (let i = 0; i < sourceNodes.length; i += 1) {
    const source = sourceNodes[i];
    const node = cloneNodes[i];
    if (!source || !node) continue;
    inlineCaptureStyles(source, node);
    // flattenDataUriBackgrounds is no longer needed here — prepareMediaForCapture
    // already converted data: URI backgrounds to blob: URLs on the live DOM,
    // and inlineCaptureStyles copies the blob: URL to the clone.
    node.querySelectorAll('img, video, source').forEach((media) => {
      const src = media.getAttribute('src');
      if (src && src.startsWith('/') && origin) media.setAttribute('src', origin + src);
    });
  }
  return clone;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('thumbnail raster failed'));
    image.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('jpeg failed'))), 'image/jpeg', 0.85);
  });
}
