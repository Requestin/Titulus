import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openDb, mediaAssetsDao } from '../src/db.js';
import { MediaJobs } from '../src/media.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'titulus-media-test-'));
}

function fakeSpawn(calls, { alpha = false } = {}) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (command === 'ffprobe') {
        child.stdout.emit('data', Buffer.from(JSON.stringify({
          streams: [{
            codec_name: 'vp9',
            width: 1920,
            height: 430,
            avg_frame_rate: '25/1',
            pix_fmt: 'yuv420p',
            tags: alpha ? { alpha_mode: '1' } : {},
          }],
        })));
      }
      child.emit('close', 0);
    });
    return child;
  };
}

test('media asset persists playback metadata across a database reopen', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'app.db');
    const db = openDb(path);
    const dao = mediaAssetsDao(db);
    dao.create({
      id: 'asset-1',
      type: 'video',
      status: 'ready',
      originalName: 'clip.webm',
      sourceMime: 'video/webm',
      sourceSizeBytes: 123,
      sourceFilename: 'source.webm',
      playbackFilename: 'asset-1.webm',
      posterFilename: 'asset-1.jpg',
      profile: 'vp9-alpha-50p',
      hasAlpha: false,
      probe: { width: 1920, height: 430, fps: 25 },
      attempts: 1,
      maxAttempts: 2,
      error: null,
    });
    db.close();

    const reopened = openDb(path);
    const asset = mediaAssetsDao(reopened).get('asset-1');
    assert.deepEqual(asset, {
      id: 'asset-1',
      type: 'video',
      status: 'ready',
      originalName: 'clip.webm',
      sourceMime: 'video/webm',
      sourceSizeBytes: 123,
      src: '/uploads/source.webm',
      url: '/uploads/asset-1.webm',
      posterUrl: '/uploads/asset-1.jpg',
      profile: 'vp9-alpha-50p',
      hasAlpha: false,
      probe: { width: 1920, height: 430, fps: 25 },
      attempts: 1,
      maxAttempts: 2,
      error: null,
    });
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video ingest defaults opaque playback to normalized H264', async () => {
  const dir = tempDir();
  try {
    const db = openDb(join(dir, 'app.db'));
    const calls = [];
    const jobs = new MediaJobs(db, dir, {
      spawn: fakeSpawn(calls),
      promote: () => {},
      remove: () => {},
    });
    const job = jobs.ingest({
      path: join(dir, 'source.webm'),
      filename: 'source.webm',
      originalname: 'source.webm',
      mimetype: 'video/webm',
      size: 123,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const ffmpeg = calls.find((call) => call.command === 'ffmpeg');
    assert.equal(job.status, 'ready');
    assert.equal(job.profile, 'h264-opaque-50p');
    assert.match(job.url, /\.mp4$/);
    assert.ok(ffmpeg.args.includes('libx264'));
    assert.ok(ffmpeg.args.some((arg) => arg.endsWith('.part.mp4')));
    assert.ok(ffmpeg.args.some((arg) => arg.startsWith('fps=50,')));
    assert.ok(ffmpeg.args.some((arg) => arg.includes('force_original_aspect_ratio=decrease')));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pending video job is recovered after backend restart', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'app.db');
    const db = openDb(path);
    mediaAssetsDao(db).create({
      id: 'recover-1',
      type: 'video',
      status: 'pending',
      originalName: 'clip.webm',
      sourceMime: 'video/webm',
      sourceSizeBytes: 123,
      sourceFilename: 'source.webm',
      playbackFilename: 'recover-1.webm',
      posterFilename: 'recover-1.jpg',
      profile: '',
      hasAlpha: false,
      probe: {},
      attempts: 0,
      maxAttempts: 2,
      error: null,
    });
    db.close();
    writeFileSync(join(dir, 'source.webm'), 'source');

    const reopened = openDb(path);
    const jobs = new MediaJobs(reopened, dir, {
      spawn: fakeSpawn([]),
      promote: () => {},
      remove: () => {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(jobs.get('recover-1').status, 'ready');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alpha source keeps the alpha-capable playback profile', async () => {
  const dir = tempDir();
  try {
    const db = openDb(join(dir, 'app.db'));
    const calls = [];
    const jobs = new MediaJobs(db, dir, {
      spawn: fakeSpawn(calls, { alpha: true }),
      promote: () => {},
      remove: () => {},
    });
    const job = jobs.ingest({
      path: join(dir, 'source.webm'),
      filename: 'source.webm',
      originalname: 'source.webm',
      mimetype: 'video/webm',
      size: 123,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const ffmpeg = calls.find((call) => call.command === 'ffmpeg');
    assert.equal(job.profile, 'vp9-alpha-50p');
    assert.ok(ffmpeg.args.some((arg) => arg.endsWith('format=yuva420p')));
    assert.ok(ffmpeg.args.includes('-auto-alt-ref'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opaque h264 profile writes an MP4 playback derivative', async () => {
  const dir = tempDir();
  try {
    const db = openDb(join(dir, 'app.db'));
    const calls = [];
    const jobs = new MediaJobs(db, dir, {
      spawn: fakeSpawn(calls),
      promote: () => {},
      remove: () => {},
      opaqueCodec: 'h264',
    });
    const job = jobs.ingest({
      path: join(dir, 'source.webm'),
      filename: 'source.webm',
      originalname: 'source.webm',
      mimetype: 'video/webm',
      size: 123,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const ffmpeg = calls.find((call) => call.command === 'ffmpeg');
    assert.equal(job.profile, 'h264-opaque-50p');
    assert.match(job.url, /\.mp4$/);
    assert.ok(ffmpeg.args.includes('libx264'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
