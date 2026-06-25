// backend/src/media.js
//
// Media ingest + transcode pipeline (DEVELOPMENT_PROMPT §7.5, REQ-10).
//
// On video upload we transcode to CEF-friendly VP9/WebM **with alpha** so video
// layers can carry transparency on air (same approach as CasparCG 2.5 WebM
// alpha). Images are stored as-is. A poster JPEG (first frame) is generated for
// thumbnails. Jobs run async; the frontend polls GET /api/uploads/jobs/:id.
//
// ffmpeg alpha notes (verified on this host, ffmpeg 6.1 + libvpx):
//   - alpha must be forced into the encoder with `-vf format=yuva420p`
//     (`-pix_fmt yuva420p` alone gets negotiated away to yuv420p).
//   - `-auto-alt-ref 0` is required (alt-ref frames can't carry alpha).
//   - The WebM carries alpha via the container `alpha_mode=1` tag (a separate
//     hidden plane), so ffprobe reports the main stream as yuv420p — that is
//     expected. Chrome/CEF read `alpha_mode=1` to composite transparency.
//   - Audio is dropped (`-an`): title graphics are silent overlays.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

/** Map a MIME type to our media kind, or null if unsupported. */
export function mediaTypeFor(mime) {
  if (typeof mime === 'string' && mime.startsWith('image/')) return 'image';
  if (VIDEO_MIME.has(mime)) return 'video';
  return null;
}

const nowIso = () => new Date().toISOString();

export class MediaJobs {
  /** @param {string} uploadsDir absolute path to data/uploads */
  constructor(uploadsDir) {
    this.uploadsDir = uploadsDir;
    mkdirSync(uploadsDir, { recursive: true });
    /** @type {Map<string, object>} id -> job */
    this.jobs = new Map();
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  _publicUrl(file) {
    return `/uploads/${file}`;
  }

  /**
   * Ingest a multer file. Images are immediately ready; videos kick off an
   * async transcode. Returns the (possibly still-processing) job.
   * @param {{ path: string, filename: string, originalname: string, mimetype: string }} file
   */
  ingest(file) {
    const id = randomUUID();
    const type = mediaTypeFor(file.mimetype);

    if (type === 'image') {
      const job = {
        id, type, status: 'ready',
        originalName: file.originalname,
        src: this._publicUrl(file.filename),
        url: this._publicUrl(file.filename),
        posterUrl: this._publicUrl(file.filename),
        error: null, createdAt: nowIso(), updatedAt: nowIso(),
      };
      this.jobs.set(id, job);
      return job;
    }

    // video → transcode
    const outName = `${id}.webm`;
    const posterName = `${id}.jpg`;
    const job = {
      id, type, status: 'pending',
      originalName: file.originalname,
      src: this._publicUrl(file.filename),
      url: this._publicUrl(outName),
      posterUrl: this._publicUrl(posterName),
      error: null, createdAt: nowIso(), updatedAt: nowIso(),
    };
    this.jobs.set(id, job);
    this._transcode(job, file.path, resolve(this.uploadsDir, outName), resolve(this.uploadsDir, posterName));
    return job;
  }

  _transcode(job, srcPath, outPath, posterPath) {
    job.status = 'processing';
    job.updatedAt = nowIso();

    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', srcPath,
      '-an',
      '-c:v', 'libvpx-vp9',
      '-vf', 'format=yuva420p',     // force alpha into the encoder
      '-auto-alt-ref', '0',         // required for alpha
      '-b:v', '0', '-crf', '24',    // CRF (sharp edges/text in graphics)
      '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3',
      outPath,
    ];

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', (err) => this._fail(job, `ffmpeg spawn failed: ${err.message}`));
    ff.on('close', (code) => {
      if (code !== 0) return this._fail(job, `ffmpeg exited ${code}: ${stderr.slice(-500)}`);
      // Poster is best-effort: a missing poster must not fail the job.
      const pp = spawn('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', srcPath, '-frames:v', '1', '-q:v', '3', posterPath,
      ]);
      pp.on('error', () => this._ready(job));
      pp.on('close', () => this._ready(job));
    });
  }

  _ready(job) {
    job.status = 'ready';
    job.updatedAt = nowIso();
  }

  _fail(job, msg) {
    job.status = 'error';
    job.error = msg;
    job.updatedAt = nowIso();
  }
}
