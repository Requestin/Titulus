#!/usr/bin/env node
import { CdpSession, listTargets, pickRendererTarget, sleep } from './cdp-client.mjs';

const targets = await listTargets(9222);
const page = pickRendererTarget(targets);
const session = new CdpSession(page.webSocketDebuggerUrl);
await session.connect();
await session.send('Runtime.enable');
await session.send('Profiler.enable');

await session.send('Profiler.start');
await sleep(3000);
const { profile } = await session.send('Profiler.stop');
console.log('nodes', profile?.nodes?.length, 'samples', profile?.samples?.length);
const top = new Map();
if (profile?.nodes && profile?.samples) {
  for (const sid of profile.samples) {
    const n = profile.nodes.find((x) => x.id === sid);
    const fn = n?.callFrame?.functionName || '(anon)';
    top.set(fn, (top.get(fn) || 0) + 1);
  }
}
console.log([...top.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15));
session.close();
