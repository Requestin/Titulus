#!/usr/bin/env node
/** Debug Tracing.end response shape */
import { CdpSession, listTargets, pickRendererTarget, sleep } from './cdp-client.mjs';

async function tryTrace(label, wsUrl) {
  const session = new CdpSession(wsUrl);
  await session.connect();
  const collected = [];
  session.on('Tracing.dataCollected', (p) => collected.push(p));
  try {
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: {
        recordMode: 'recordUntilFull',
        includedCategories: ['blink', 'cc', 'devtools.timeline'],
      },
    });
    await sleep(2000);
    const end = await session.send('Tracing.end');
    await sleep(500);
    console.log(`[${label}] end=`, JSON.stringify(end));
    console.log(`[${label}] dataCollected=`, collected.length);
    if (end?.stream) {
      try {
        const chunk = await session.send('IO.read', { handle: end.stream, size: 65536 });
        console.log(`[${label}] IO.read bytes=`, chunk.data?.length || 0, 'eof=', chunk.eof);
      } catch (e) {
        console.log(`[${label}] IO.read err`, e.message);
      }
    }
  } catch (e) {
    console.log(`[${label}] err`, e.message);
  }
  session.close();
}

const ver = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json());
const targets = await listTargets(9222);
const page = pickRendererTarget(targets);
await tryTrace('browser', ver.webSocketDebuggerUrl);
await tryTrace('page', page.webSocketDebuggerUrl);
