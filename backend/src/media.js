// backend/src/media.js
//
// Durable media ingest + playback-profile preparation. Upload handlers persist
// the source first; all expensive probe/transcode work runs on a bounded local
// queue so it cannot block the HTTP request or overwhelm live engines.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { mediaAssetsDao } from './db.js';

const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MAX_TRANSCODE_ATTEMPTS = 2;
const TRANSCODE_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_ERROR_TAIL = 1200;
const MAX_VIDEO_WIDTH = 3840;
const MAX_VIDEO_HEIGHT = 2160;
const MAX_VIDEO_FPS = 120;

/** Map a MIME type to our media kind, or null if unsupported. */
export function mediaTypeFor(mime) {
  if (typeof mime === 'string' && mime.startsWith('image/')) return 'image';
  if (VIDEO_MIME.has(mime)) return 'video';
  return null;
}

const publicUrl = (filename) => `/uploads/${filename}`;

function fpsFromRational(value) {
  const [numerator, denominator] = String(value ?? '').split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

function mediaError(code, message, details = '') {
  return { code, message, details: String(details).slice(-MAX_ERROR_TAIL) };
}

/**
 * Upload source + playback derivative manager.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} uploadsDir
 * @param {{
 *   spawn?: typeof nodeSpawn,
 *   maxConcurrent?: number,
 *   promote?: (source: string, destination: string) => void,
 *   remove?: (path: string, options: { force: boolean }) => void,
 *   exists?: (path: string) => boolean,
 *   ffprobePath?: string,
 *   ffmpegPath?: string,
 *   opaqueCodec?: 'vp9' | 'h264',
 * }} [options]
 */
export class MediaJobs {
  constructor(db, uploadsDir, options = {}) {
    this.uploadsDir = uploadsDir;
    this.dao = mediaAssetsDao(db);
    this.spawn = options.spawn ?? nodeSpawn;
    const configuredConcurrency = Number(
      options.maxConcurrent ?? process.env.TITULUS_MEDIA_TRANSCODE_CONCURRENCY ?? 1,
    );
    this.maxConcurrent = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
      ? Math.floor(configuredConcurrency)
      : 1;
    this.promote = options.promote ?? renameSync;
    this.remove = options.remove ?? rmSync;
    this.exists = options.exists ?? existsSync;
    this.ffprobePath = options.ffprobePath ?? 'ffprobe';
    this.ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
    this.opaqueCodec = options.opaqueCodec ?? process.env.TITULUS_OPAQUE_VIDEO_CODEC ?? 'h264';
    if (!['vp9', 'h264'].includes(this.opaqueCodec)) {
      throw new Error('TITULUS_OPAQUE_VIDEO_CODEC must be vp9 or h264');
    }
    this.queue = [];
    this.active = 0;
    this.live = new Map();
    mkdirSync(uploadsDir, { recursive: true });
    this.recover();
  }

  get(id) {
    return this.live.get(id)?.job ?? this.dao.get(id);
  }

  ingest(file) {
    const id = randomUUID();
    const type = mediaTypeFor(file.mimetype);
    const size = typeof file.size === 'number' ? file.size : 0;

    if (type === 'image') {
      return this.dao.create({
        id,
        type,
        status: 'ready',
        originalName: file.originalname,
        sourceMime: file.mimetype,
        sourceSizeBytes: size,
        sourceFilename: file.filename,
        playbackFilename: file.filename,
        posterFilename: file.filename,
        profile: 'source-image',
        hasAlpha: false,
        probe: {},
        attempts: 0,
        maxAttempts: 0,
        error: null,
      });
    }

    const playbackFilename = `${id}.webm`;
    const posterFilename = `${id}.jpg`;
    const job = this.dao.create({
      id,
      type,
      status: size > 0 ? 'pending' : 'error',
      originalName: file.originalname,
      sourceMime: file.mimetype,
      sourceSizeBytes: size,
      sourceFilename: file.filename,
      playbackFilename,
      posterFilename,
      profile: '',
      hasAlpha: false,
      probe: {},
      attempts: 0,
      maxAttempts: MAX_TRANSCODE_ATTEMPTS,
      error: size > 0 ? null : mediaError('EMPTY_UPLOAD', 'uploaded file is empty'),
    });
    if (size <= 0) return job;

    const state = this._stateFromRecord(this.dao.record(id));
    this.live.set(id, state);
    this._enqueue(state);
    return state.job;
  }

  recover() {
    for (const record of this.dao.recoverableRecords()) {
      const state = this._stateFromRecord(record);
      if (!this.exists(state.sourcePath)) {
        this._fail(state, mediaError('SOURCE_MISSING', 'uploaded source is missing'));
        continue;
      }
      state.job.status = 'pending';
      state.job.error = null;
      this._persist(state);
      this.live.set(state.job.id, state);
      this._enqueue(state);
    }
  }

  _stateFromRecord(record) {
    const job = this.dao.get(record.id);
    return {
      job,
      sourcePath: resolve(this.uploadsDir, record.source_filename),
      playbackFilename: record.playback_filename,
      playbackPath: resolve(this.uploadsDir, record.playback_filename),
      posterPath: resolve(this.uploadsDir, record.poster_filename),
    };
  }

  _enqueue(state) {
    this.queue.push(state);
    this._drain();
  }

  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const state = this.queue.shift();
      this.active += 1;
      this._process(state)
        .catch((error) => this._retryOrFail(state, error))
        .finally(() => {
          this.active -= 1;
          this._drain();
        });
    }
  }

  async _process(state) {
    state.job.status = 'processing';
    state.job.error = null;
    state.job.attempts += 1;
    this._persist(state);

    const probe = await this._probe(state.sourcePath);
    const profile = this._playbackProfile(probe.hasAlpha);
    this._setPlaybackFilename(state, `${state.job.id}.${profile.extension}`);
    state.job.probe = probe;
    state.job.hasAlpha = probe.hasAlpha;
    state.job.profile = profile.name;
    this._persist(state);

    const playbackTemp = this._temporaryPath(state.playbackPath);
    const posterTemp = this._temporaryPath(state.posterPath);
    this.remove(playbackTemp, { force: true });
    this.remove(posterTemp, { force: true });

    await this._runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', state.sourcePath,
      '-an',
      '-vf', this._playbackFilter(probe.hasAlpha),
      ...profile.ffmpegArgs,
      playbackTemp,
    ]);
    this.promote(playbackTemp, state.playbackPath);

    try {
      await this._runFfmpeg([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', state.sourcePath, '-frames:v', '1', '-q:v', '3', posterTemp,
      ]);
      this.promote(posterTemp, state.posterPath);
    } catch {
      this.remove(posterTemp, { force: true });
    }

    state.job.status = 'ready';
    state.job.error = null;
    this._persist(state);
  }

  _playbackFilter(hasAlpha) {
    const pixFmt = hasAlpha ? 'yuva420p' : 'yuv420p';
    return [
      'fps=50',
      `scale='min(${MAX_VIDEO_WIDTH},iw)':'min(${MAX_VIDEO_HEIGHT},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `format=${pixFmt}`,
    ].join(',');
  }

  _temporaryPath(path) {
    const extension = path.lastIndexOf('.') >= 0 ? path.slice(path.lastIndexOf('.')) : '';
    return `${path.slice(0, path.length - extension.length)}.part${extension}`;
  }

  _playbackProfile(hasAlpha) {
    if (hasAlpha) {
      return {
        name: 'vp9-alpha-50p',
        extension: 'webm',
        ffmpegArgs: [
          '-c:v', 'libvpx-vp9',
          '-auto-alt-ref', '0',
          '-b:v', '0', '-crf', '24',
          '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3',
        ],
      };
    }
    if (this.opaqueCodec === 'h264') {
      return {
        name: 'h264-opaque-50p',
        extension: 'mp4',
        ffmpegArgs: [
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '20',
          '-movflags', '+faststart',
        ],
      };
    }
    return {
      name: 'vp9-opaque-50p',
      extension: 'webm',
      ffmpegArgs: [
        '-c:v', 'libvpx-vp9',
        '-b:v', '0', '-crf', '24',
        '-row-mt', '1', '-deadline', 'good', '-cpu-used', '3',
      ],
    };
  }

  _setPlaybackFilename(state, filename) {
    if (state.playbackFilename === filename) return;
    state.playbackFilename = filename;
    state.playbackPath = resolve(this.uploadsDir, filename);
    const updated = this.dao.setPlaybackFilename(state.job.id, filename);
    Object.assign(state.job, updated);
  }

  async _probe(sourcePath) {
    const raw = await this._run(this.ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,pix_fmt:stream_tags=alpha_mode',
      '-of', 'json',
      sourcePath,
    ]);
    let parsed;
    try {
      parsed = JSON.parse(raw.stdout);
    } catch {
      throw mediaError('FFPROBE_INVALID_OUTPUT', 'ffprobe returned invalid metadata', raw.stderr);
    }
    const stream = parsed?.streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    const fps = fpsFromRational(stream?.avg_frame_rate);
    if (
      !stream
      || !Number.isInteger(width) || !Number.isInteger(height)
      || width < 2 || height < 2
      || width > MAX_VIDEO_WIDTH || height > MAX_VIDEO_HEIGHT
      || !Number.isFinite(fps) || fps <= 0 || fps > MAX_VIDEO_FPS
    ) {
      throw mediaError('INVALID_VIDEO_STREAM', 'video stream exceeds supported playback limits');
    }
    return {
      codec: String(stream.codec_name ?? ''),
      width,
      height,
      fps,
      pixFmt: String(stream.pix_fmt ?? ''),
      hasAlpha: String(stream.pix_fmt ?? '').startsWith('yuva') || stream.tags?.alpha_mode === '1',
    };
  }

  _runFfmpeg(args) {
    return this._run(this.ffmpegPath, args, { timeoutMs: TRANSCODE_TIMEOUT_MS });
  }

  _run(command, args, { timeoutMs = 0 } = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };
      const child = this.spawn(command, args);
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          child.kill('SIGKILL');
          finish(rejectPromise, mediaError('FFMPEG_TIMEOUT', 'media processing timed out'));
        }, timeoutMs)
        : null;
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > MAX_ERROR_TAIL * 2) stderr = stderr.slice(-MAX_ERROR_TAIL * 2);
      });
      child.on('error', (error) => {
        finish(rejectPromise, mediaError(
          command === this.ffprobePath ? 'FFPROBE_SPAWN_ERROR' : 'FFMPEG_SPAWN_ERROR',
          `${command} spawn failed: ${error.message}`,
          stderr,
        ));
      });
      child.on('close', (code) => {
        if (code !== 0) {
          finish(rejectPromise, mediaError(
            command === this.ffprobePath ? 'FFPROBE_FAILED' : 'FFMPEG_TRANSCODE_FAILED',
            `${command} exited with code ${code}`,
            stderr,
          ));
          return;
        }
        finish(resolvePromise, { stdout, stderr });
      });
    });
  }

  _retryOrFail(state, error) {
    const normalized = error?.code
      ? error
      : mediaError('MEDIA_PROCESSING_FAILED', error instanceof Error ? error.message : 'media processing failed');
    if (state.job.attempts < state.job.maxAttempts && normalized.code !== 'INVALID_VIDEO_STREAM') {
      state.job.status = 'pending';
      state.job.error = { ...normalized, retriable: true, attempt: state.job.attempts };
      this._persist(state);
      this._enqueue(state);
      return;
    }
    this._fail(state, { ...normalized, retriable: false, attempts: state.job.attempts });
  }

  _fail(state, error) {
    state.job.status = 'error';
    state.job.error = error;
    this._persist(state);
  }

  _persist(state) {
    const updated = this.dao.update(state.job);
    Object.assign(state.job, updated);
  }
}
