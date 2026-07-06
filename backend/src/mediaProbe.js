// backend/src/mediaProbe.js — ffprobe metadata for media library assets.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseFps(rate) {
  if (!rate || typeof rate !== 'string') return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return 0;
  return n / d;
}

function streamHasAlpha(stream) {
  if (!stream) return false;
  const pix = (stream.pix_fmt || '').toLowerCase();
  if (pix.includes('a') || pix.includes('alpha')) return true;
  const tags = stream.tags || {};
  return tags.alpha_mode === '1' || tags.ALPHA_MODE === '1';
}

/**
 * @param {string} filePath
 * @returns {Promise<{
 *   width: number, height: number, format: string,
 *   hasAlpha: boolean, durationSec: number, fps: number, durationFrames: number
 * } | null>}
 */
export async function probeMediaFile(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ], { timeout: 30_000 });
    const data = JSON.parse(stdout);
    const video = data.streams?.find((s) => s.codec_type === 'video');
    const image = data.streams?.find((s) => s.codec_type === 'video' || s.codec_type === 'image');
    const stream = video || image || data.streams?.[0];
    const fmt = data.format || {};
    const width = Number(stream?.width) || 0;
    const height = Number(stream?.height) || 0;
    const durationSec = Number(fmt.duration || stream?.duration) || 0;
    const fps = parseFps(stream?.avg_frame_rate || stream?.r_frame_rate);
    const durationFrames = fps > 0 ? Math.round(durationSec * fps) : 0;
    const format = (fmt.format_name || stream?.codec_name || '').split(',')[0] || '';
    const hasAlpha = streamHasAlpha(stream);
    return { width, height, format, hasAlpha, durationSec, fps, durationFrames };
  } catch {
    return null;
  }
}
