// backend/src/thumbnailRender.js
//
// Mid-timeline JPEG capture via bg_engine preview consumer (CPU-only CEF OSR).
// Snap Chromium cannot write screenshots in this environment; engine path is reliable.

import { spawn } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveThumbnailJpeg } from './thumbnails.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const DEFAULT_RUNTIME = resolve(here, '../public/bg-runtime.js');
const DEFAULT_ENGINE = process.env.TITULUS_BG_ENGINE
  || resolve(ROOT, 'engine/build/Release/bg_engine');

function midFrame(template) {
  const dur = Math.max(1, template?.timeline?.durationFrames ?? 1);
  return Math.floor(dur / 2);
}

function buildHtml({ template, runtimeJs, frame }) {
  const tw = template.canvas?.width || 1920;
  const th = template.canvas?.height || 1080;
  const payload = JSON.stringify(template).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;background:#000;overflow:hidden;width:${tw}px;height:${th}px;}
  #stage{position:relative;width:${tw}px;height:${th}px;}
</style></head>
<body>
<div id="stage"></div>
<script>${runtimeJs}<\/script>
<script>
(function(){
  var template = ${payload};
  var frame = ${frame};
  var stage = document.getElementById('stage');
  var BG = window.BG;
  if (!BG || !BG.TemplateRenderer) return;
  var vars = BG.resolveVariableMap ? BG.resolveVariableMap(template) : {};
  var r = new BG.TemplateRenderer(stage, {
    playbackMode: 'fixed',
    fixedTickRate: (template.timeline && template.timeline.fps) || 50
  });
  r.syncTemplate(template, vars);
  r.seek(frame);
  // Perpetual rAF so CEF OSR keeps painting.
  (function beat(){ requestAnimationFrame(beat); })();
})();
<\/script>
</body></html>`;
}

function listenStatic(rootDir) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        let filePath = join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
        if (!filePath.startsWith(rootDir)) {
          res.writeHead(403); res.end(); return;
        }
        // Also serve /uploads from the real uploads dir via symlink/path rewrite below.
        if (!existsSync(filePath)) {
          res.writeHead(404); res.end('not found'); return;
        }
        const data = readFileSync(filePath);
        const lower = filePath.toLowerCase();
        const type = lower.endsWith('.html') ? 'text/html'
          : lower.endsWith('.js') ? 'application/javascript'
            : lower.endsWith('.css') ? 'text/css'
              : lower.endsWith('.png') ? 'image/png'
                : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg'
                  : lower.endsWith('.webm') ? 'video/webm'
                    : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        res.end(data);
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise({ server, port: addr.port });
    });
    server.on('error', reject);
  });
}

function runEngine({ engine, url, outJpeg, cacheDir, width, height, fps }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      `--consumer=preview`,
      `--preview-out=${outJpeg}`,
      `--preview-fps=5`,
      `--url=${url}`,
      `--width=${width}`,
      `--height=${height}`,
      `--fps=${fps}`,
      `--duration=2`,
      `--cache-dir=${cacheDir}`,
    ];
    const env = { ...process.env };
    delete env.DISPLAY; // must be unset (not "") so CEF picks ozone-platform=headless
    const child = spawn(engine, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || existsSync(outJpeg)) resolvePromise({ stderr, code });
      else reject(new Error(`bg_engine exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Render template mid-timeline → JPEG under $dataDir/thumbnails/{id}.jpg
 * @returns {Promise<string>} public thumbnail URL
 */
export async function renderAndSaveThumbnail({
  dataDir,
  template,
  uploadsDir,
  runtimePath = DEFAULT_RUNTIME,
  enginePath = DEFAULT_ENGINE,
}) {
  if (!template?.id) throw new Error('template.id required');
  if (!existsSync(runtimePath)) throw new Error(`bg-runtime.js missing at ${runtimePath}`);
  if (!existsSync(enginePath)) throw new Error(`bg_engine missing at ${enginePath}`);

  const runtimeJs = readFileSync(runtimePath, 'utf8');
  const frame = midFrame(template);
  const html = buildHtml({ template, runtimeJs, frame });

  const work = mkdtempSync(join(tmpdir(), 'titulus-thumb-'));
  const webRoot = join(work, 'www');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), html);

  // Expose uploads to the thumb page at /uploads/...
  const uploadsLink = join(webRoot, 'uploads');
  try {
    symlinkSync(uploadsDir, uploadsLink);
  } catch {
    // fallback: leave missing — solid graphics without media still render
  }

  const outFull = join(work, 'full.jpg');
  const outScaled = join(work, 'thumb.jpg');
  const cacheDir = join(work, 'cef-cache');
  mkdirSync(cacheDir, { recursive: true });

  const tw = template.canvas?.width || 1920;
  const th = template.canvas?.height || 1080;
  const fps = template.timeline?.fps || 50;

  let server;
  try {
    const listened = await listenStatic(webRoot);
    server = listened.server;
    const url = `http://127.0.0.1:${listened.port}/index.html`;

    await runEngine({
      engine: enginePath,
      url,
      outJpeg: outFull,
      cacheDir,
      width: tw,
      height: th,
      fps,
    });

    if (!existsSync(outFull)) {
      throw new Error('preview JPEG was not written');
    }

    // Downscale to ~480px wide for library cards.
    const outW = 480;
    const outH = Math.max(1, Math.round((outW * th) / tw));
    await new Promise((resolvePromise, reject) => {
      const ff = spawn('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', outFull,
        '-vf', `scale=${outW}:${outH}`,
        '-q:v', '3',
        outScaled,
      ]);
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`ffmpeg scale exit ${code}`))));
    });

    const buf = readFileSync(outScaled);
    return saveThumbnailJpeg(dataDir, template.id, buf);
  } finally {
    try { server?.close(); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
