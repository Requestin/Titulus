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
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('jpeg failed'))), 'image/jpeg', 0.85);
  });
}
