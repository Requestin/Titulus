#!/usr/bin/env node
/**
 * Collect Blink research artifacts from a live bg_engine renderer:
 *   - Chromium trace-startup JSON from cache dir (when remote debugging enabled)
 *   - CDP Profiler sample (JS flamegraph proxy — Tracing CDP is inactive in CEF)
 *
 * Usage:
 *   node engine/research/collect-cdp-trace.mjs \
 *     --port=9222 --duration=15 \
 *     --cache-dir=/tmp/titulus-engines/cache-... \
 *     --out=/tmp/trace.json
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CdpSession, listTargets, pickRendererTarget, sleep } from './cdp-client.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const port = Number(arg('port', '9222'));
const durationSec = Number(arg('duration', '15'));
const cacheDir = arg('cache-dir', '');
const outPath = arg('out', `/tmp/titulus-blink-trace-${Date.now()}.json`);
const profileOut = arg('profile-out', outPath.replace(/\.json$/, '-js-profile.json'));

async function collectProfiler(session, seconds) {
  await session.send('Runtime.enable');
  await session.send('Profiler.enable');
  await session.send('Profiler.start');
  await sleep(seconds * 1000);
  const { profile } = await session.send('Profiler.stop');

  /** @type {Map<string, number>} */
  const counts = new Map();
  if (profile?.nodes && profile?.samples) {
    for (const sid of profile.samples) {
      const node = profile.nodes.find((n) => n.id === sid);
      const fn = node?.callFrame?.functionName || '(anon)';
      const url = node?.callFrame?.url || '';
      const key = fn + (url ? ` @ ${url}` : '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name, samples]) => ({ name, samples }));

  const payload = {
    durationSec: seconds,
    sampleCount: profile?.samples?.length ?? 0,
    nodeCount: profile?.nodes?.length ?? 0,
    topSymbols: top,
  };
  writeFileSync(profileOut, JSON.stringify(payload, null, 2));
  console.log(`[trace] JS profile: ${payload.sampleCount} samples → ${profileOut}`);
  return payload;
}

async function main() {
  const startupTrace = cacheDir ? `${cacheDir}/blink-trace.json` : '';
  if (startupTrace && existsSync(startupTrace)) {
    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(startupTrace, outPath);
    const n = JSON.parse(readFileSync(outPath, 'utf8')).traceEvents?.length ?? 0;
    console.log(`[trace] copied startup trace ${startupTrace} → ${outPath} (${n} events)`);
  } else if (startupTrace) {
    console.log(`[trace] waiting for ${startupTrace} (trace-startup-duration)…`);
    for (let i = 0; i < durationSec + 10; i++) {
      if (existsSync(startupTrace)) {
        copyFileSync(startupTrace, outPath);
        console.log(`[trace] copied after ${i + 1}s`);
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    if (!existsSync(outPath)) {
      console.warn(`[trace] startup trace not found at ${startupTrace}`);
      writeFileSync(outPath, JSON.stringify({ traceEvents: [] }), 'utf8');
    }
  }

  const targets = await listTargets(port);
  const target = pickRendererTarget(targets);
  console.log(`[trace] profiler target: ${target.url}`);

  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await collectProfiler(session, durationSec);
  session.close();
}

main().catch((err) => {
  console.error('[trace] FAILED:', err.message || err);
  process.exit(1);
});
