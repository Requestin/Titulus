import { TemplateRenderer, resolveThumbnailFrame, resolveVariableMap, type Template } from '@runtime';

export function thumbnailLabel(name: string, max = 42): string {
  const trimmed = name.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
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
  const frame = resolveThumbnailFrame(template.timeline);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-12000px;top:0;pointer-events:none;opacity:0;';
  document.body.appendChild(host);
  const renderer = new TemplateRenderer(host, { playbackMode: 'raf' });
  try {
    renderer.syncTemplate(template, resolveVariableMap(template), { reuseDirectors: false });
    renderer.seek(frame);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return await captureElementJpeg(renderer.getRoot(), width, height);
  } finally {
    renderer.destroy();
    host.remove();
  }
}

async function captureElementJpeg(el: HTMLElement, outW: number, outH: number): Promise<Blob> {
  const sourceW = Math.max(1, el.offsetWidth || 1920);
  const sourceH = Math.max(1, el.offsetHeight || 1080);
  const serialized = new XMLSerializer().serializeToString(el);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceW}" height="${sourceH}">`
    + `<foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unsupported');
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(image, 0, 0, outW, outH);
    return await canvasToJpeg(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
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
