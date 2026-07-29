// backend/src/media.js
//
// Media ingest + transcode pipeline (DEVELOPMENT_PROMPT §7.5, REQ-10).
//
// On video upload we transcode to CEF-friendly WebM:
//   - Source WITH alpha  → VP9 + yuva420p (alpha_mode) for keyed overlays
//   - Source WITHOUT alpha → VP8 + yuv420p (NO alpha plane)
// Forcing alpha on opaque clips previously starved CEF OSR on SDI (stutter /
// strobing of the whole channel). Images are stored as-is. A poster JPEG
// (first frame) is generated for thumbnails.
//
// ffmpeg alpha notes (verified on this host, ffmpeg 6.1 + libvpx):
//   - alpha must be forced into the encoder with `-vf format=yuva420p`
//     (`-pix_fmt yuva420p` alone gets negotiated away to yuv420p).
//   - `-auto-alt-ref 0` is required (alt-ref frames can't carry alpha).
//   - The WebM carries alpha via the container `alpha_mode=1` tag (a separate
//     hidden plane), so ffprobe reports the main stream as yuv420p — that is
//     expected. Chrome/CEF read `alpha_mode=1` to composite transparency.
//   - Audio is dropped (`-an`): title graphics are silent overlays.
//   - Opaque path uses libvpx (VP8): cheaper software decode in CEF OSR.

import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const TEXT_MIME = new Set(['text/plain', 'application/txt']);
const MAX_TRANSCODE_ATTEMPTS = 2;
const TRANSCODE_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes per attempt
const MAX_ERROR_TAIL = 1200;

/** Map a MIME type to our media kind, or null if unsupported. */
export function mediaTypeFor(mime) {
  if (typeof mime === 'string' && mime.startsWith('image/')) return 'image';
  if (VIDEO_MIME.has(mime)) return 'video';
  if (typeof mime === 'string' && (TEXT_MIME.has(mime) || mime === 'text/plain')) return 'text';
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

  _publicUrl(relativePath) {
    return `/uploads/${relativePath}`;
  }

  /**
   * Ingest into a specific subdirectory under uploads (e.g. Video/).
   * @param {string} targetDir absolute path to Image/ or Video/ folder
   * @param {{ path: string, filename: string, originalname: string, mimetype: string, size?: number }} file
   */
  ingestTo(targetDir, file) {
    const id = randomUUID();
    const type = mediaTypeFor(file.mimetype);
    const size = typeof file.size === 'number' ? file.size : 0;
    const folderName = targetDir.endsWith('Video') || targetDir.includes('/Video') ? 'Video' : 'Image';

    if (type === 'image') {
      const rel = `${folderName}/${file.filename}`;
      const job = {
        id, type, status: 'ready',
        originalName: file.originalname,
        sourceMime: file.mimetype,
        sourceSizeBytes: size,
        src: this._publicUrl(rel),
        url: this._publicUrl(rel),
        posterUrl: this._publicUrl(rel),
        attempts: 0, maxAttempts: 0,
        error: null, createdAt: nowIso(), updatedAt: nowIso(),
      };
      this.jobs.set(id, job);
      return job;
    }

    const outName = `${id}.webm`;
    const posterName = `${id}.jpg`;
    const outRel = `${folderName}/${outName}`;
    const posterRel = `${folderName}/${posterName}`;
    const outPath = resolve(targetDir, outName);
    const posterPath = resolve(targetDir, posterName);
    const job = {
      id, type, status: 'pending',
      originalName: file.originalname,
      sourceMime: file.mimetype,
      sourceSizeBytes: size,
      src: this._publicUrl(`${folderName}/${file.filename}`),
      url: this._publicUrl(outRel),
      posterUrl: this._publicUrl(posterRel),
      sourcePath: file.path,
      attempts: 0,
      maxAttempts: MAX_TRANSCODE_ATTEMPTS,
      error: null, createdAt: nowIso(), updatedAt: nowIso(),
    };
    this.jobs.set(id, job);
    if (size <= 0) {
      this._fail(job, { code: 'EMPTY_UPLOAD', message: 'uploaded file is empty' });
      return job;
    }
    this._transcode(job, file.path, outPath, posterPath);
    return job;
  }

  /**
   * Ingest a multer file. Images are immediately ready; videos kick off an
   * async transcode. Returns the (possibly still-processing) job.
   * @param {{ path: string, filename: string, originalname: string, mimetype: string }} file
   */
  ingest(file) {
    const id = randomUUID();
    let type = mediaTypeFor(file.mimetype);
    if (!type && typeof file.originalname === 'string' && /\.txt$/i.test(file.originalname)) {
      type = 'text';
    }
    const size = typeof file.size === 'number' ? file.size : 0;

    if (type === 'image' || type === 'text') {
      const job = {
        id, type, status: 'ready',
        originalName: file.originalname,
        sourceMime: file.mimetype,
        sourceSizeBytes: size,
        src: this._publicUrl(file.filename),
        url: this._publicUrl(file.filename),
        posterUrl: this._publicUrl(file.filename),
        attempts: 0,
        maxAttempts: 0,
        error: null, createdAt: nowIso(), updatedAt: nowIso(),
      };
      this.jobs.set(id, job);
      return job;
    }

    // video → transcode (legacy flat uploads/)
    const outName = `${id}.webm`;
    const posterName = `${id}.jpg`;
    const job = {
      id, type, status: 'pending',
      originalName: file.originalname,
      sourceMime: file.mimetype,
      sourceSizeBytes: size,
      src: this._publicUrl(file.filename),
      url: this._publicUrl(outName),
      posterUrl: this._publicUrl(posterName),
      sourcePath: file.path,
      attempts: 0,
      maxAttempts: MAX_TRANSCODE_ATTEMPTS,
      error: null, createdAt: nowIso(), updatedAt: nowIso(),
    };
    this.jobs.set(id, job);
    if (size <= 0) {
      this._fail(job, {
        code: 'EMPTY_UPLOAD',
        message: 'uploaded file is empty',
      });
      return job;
    }
    this._transcode(job, file.path, resolve(this.uploadsDir, outName), resolve(this.uploadsDir, posterName));
    return job;
  }

  _transcode(job, srcPath, outPath, posterPath) {
    const attempt = (job.attempts || 0) + 1;
    job.attempts = attempt;
    job.status = 'processing';
    job.updatedAt = nowIso();

    // Probe source for a real alpha channel before choosing the encode path.
    // Opaque clips must NOT get alpha_mode=1 — CEF OSR software-decodes the
    // extra plane and can starve the whole 1080i50 channel (strobe on SDI).
    this._probeHasAlpha(srcPath, (hasAlpha) => {
      const args = hasAlpha
        ? [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', srcPath,
          '-an',
          '-c:v', 'libvpx-vp9',
          '-vf', 'format=yuva420p',
          '-auto-alt-ref', '0',
          '-b:v', '0', '-crf', '24',
          '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3',
          outPath,
        ]
        : [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', srcPath,
          '-an',
          '-map_metadata', '-1',
          '-c:v', 'libvpx',
          '-vf', 'format=yuv420p',
          '-b:v', '0', '-crf', '22',
          '-deadline', 'good', '-cpu-used', '4',
          outPath,
        ];
      job.hasAlpha = hasAlpha;

      const ff = spawn('ffmpeg', args);
      let stderr = '';
      const timeout = setTimeout(() => {
        ff.kill('SIGKILL');
      }, TRANSCODE_TIMEOUT_MS);

      ff.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > MAX_ERROR_TAIL * 2) {
          stderr = stderr.slice(-MAX_ERROR_TAIL * 2);
        }
      });
      ff.on('error', (err) => {
        clearTimeout(timeout);
        this._retryOrFail(job, {
          code: 'FFMPEG_SPAWN_ERROR',
          message: `ffmpeg spawn failed: ${err.message}`,
          details: this._errorTail(stderr),
        }, { attempt, srcPath, outPath, posterPath });
      });
      ff.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          return this._retryOrFail(job, {
            code: 'FFMPEG_TRANSCODE_FAILED',
            message: `ffmpeg exited with code ${code}`,
            details: this._errorTail(stderr),
          }, { attempt, srcPath, outPath, posterPath });
        }
        // Poster is best-effort: a missing poster must not fail the job.
        const pp = spawn('ffmpeg', [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', srcPath, '-frames:v', '1', '-q:v', '3', posterPath,
        ]);
        pp.on('error', () => this._ready(job));
        pp.on('close', () => this._ready(job));
      });
    });
  }

  /**
   * True when the source video has a real alpha / RGBA-style pixel format.
   * Note: WebM `alpha_mode=1` on an already-transcoded opaque file is NOT a
   * source signal — we look at pix_fmt only.
   */
  _probeHasAlpha(srcPath, cb) {
    const force = process.env.TITULUS_VIDEO_FORCE_ALPHA;
    if (force === '1' || force === 'true') {
      cb(true);
      return;
    }
    if (force === '0' || force === 'false') {
      cb(false);
      return;
    }
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt',
      '-of', 'default=nw=1:nk=1',
      srcPath,
    ]);
    let out = '';
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.on('error', () => cb(false));
    ff.on('close', () => {
      const pix = out.trim().toLowerCase();
      const has =
        pix.includes('yuva')
        || pix.includes('rgba')
        || pix.includes('argb')
        || pix.includes('bgra')
        || pix.includes('abgr')
        || pix.includes('gbrap')
        || pix === 'ya8'
        || pix === 'ya16le'
        || pix === 'ya16be';
      cb(has);
    });
  }

  _retryOrFail(job, errObj, ctx) {
    if ((ctx.attempt || 1) < MAX_TRANSCODE_ATTEMPTS) {
      job.status = 'pending';
      job.updatedAt = nowIso();
      job.error = {
        ...errObj,
        retriable: true,
        attempt: ctx.attempt,
      };
      this._transcode(job, ctx.srcPath, ctx.outPath, ctx.posterPath);
      return;
    }
    this._fail(job, {
      ...errObj,
      retriable: false,
      attempts: ctx.attempt,
    });
  }

  _errorTail(stderr) {
    if (!stderr) return '';
    return stderr.slice(-MAX_ERROR_TAIL);
  }

  _ready(job) {
    job.status = 'ready';
    job.error = null;
    job.updatedAt = nowIso();
    if (job.sourcePath) {
      try { unlinkSync(job.sourcePath); } catch { /* ignore */ }
      job.sourcePath = null;
    }
  }

  _fail(job, errObj) {
    job.status = 'error';
    job.error = errObj;
    job.updatedAt = nowIso();
  }
}
