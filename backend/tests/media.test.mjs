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

function fakeSpawn(calls, {
  alphaTag = false,
  uppercaseAlphaTag = false,
  transparentPixels = false,
  sourceFps = '25/1',
} = {}) {
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
            avg_frame_rate: sourceFps,
            pix_fmt: 'yuv420p',
            tags: alphaTag
              ? { [uppercaseAlphaTag ? 'ALPHA_MODE' : 'alpha_mode']: '1' }
              : {},
          }],
        })));
      } else if (args.some((arg) => String(arg).includes('alphaextract'))) {
        child.stdout.emit('data', Buffer.from(
          `lavfi.signalstats.YMIN=${transparentPixels ? 0 : 255}\n`,
        ));
      }
      child.emit('close', 0);
    });
    return child;
  };
}

async function settleMediaJob() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

test('opaque alpha-tagged video uses opaque animated WebP when pixels are opaque', async () => {
  const dir = tempDir();
  try {
    const db = openDb(join(dir, 'app.db'));
    const calls = [];
    const jobs = new MediaJobs(db, dir, {
      spawn: fakeSpawn(calls, { alphaTag: true, transparentPixels: false }),
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

    await settleMediaJob();

    const ffmpeg = calls.find((call) => call.args.some(
      (arg) => String(arg).endsWith('.part.webp'),
    ));
    assert.equal(job.status, 'ready');
    assert.equal(job.profile, 'webp-opaque-25p');
    assert.equal(job.hasAlpha, false);
    assert.match(job.url, /\.webp$/);
    assert.ok(ffmpeg.args.includes('libwebp_anim'));
    assert.ok(ffmpeg.args.some((arg) => arg.includes('fps=25')));
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
    await settleMediaJob();

    assert.equal(jobs.get('recover-1').status, 'ready');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video with transparent decoded pixels keeps the alpha playback profile', async () => {
  const dir = tempDir();
  try {
    const db = openDb(join(dir, 'app.db'));
    const calls = [];
    const jobs = new MediaJobs(db, dir, {
      spawn: fakeSpawn(calls, {
        alphaTag: true,
        uppercaseAlphaTag: true,
        transparentPixels: true,
      }),
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

    await settleMediaJob();

    const ffmpeg = calls.find((call) => call.args.some(
      (arg) => String(arg).endsWith('.part.webp'),
    ));
    assert.equal(job.profile, 'webp-alpha-25p');
    assert.equal(job.hasAlpha, true);
    assert.match(job.url, /\.webp$/);
    assert.ok(ffmpeg.args.some((arg) => arg.endsWith('format=yuva420p')));
    assert.ok(ffmpeg.args.includes('libwebp_anim'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('50 fps opaque source is capped to the validated 25p WebP profile', async () => {
  const dir = tempDir();
  try {
    const db = openDb(join(dir, 'app.db'));
    const calls = [];
    const jobs = new MediaJobs(db, dir, {
      spawn: fakeSpawn(calls, { sourceFps: '50/1' }),
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

    await settleMediaJob();

    const ffmpeg = calls.find((call) => call.args.some(
      (arg) => String(arg).endsWith('.part.webp'),
    ));
    assert.equal(job.profile, 'webp-opaque-25p');
    assert.match(job.url, /\.webp$/);
    assert.ok(ffmpeg.args.includes('libwebp_anim'));
    assert.ok(ffmpeg.args.some((arg) => arg.includes('fps=25')));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
