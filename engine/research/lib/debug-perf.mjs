#!/usr/bin/env node
import { CdpSession, listTargets, pickRendererTarget, sleep } from './cdp-client.mjs';

const targets = await listTargets(9222);
const page = pickRendererTarget(targets);
const session = new CdpSession(page.webSocketDebuggerUrl);
await session.connect();

for (const method of [
  'Performance.enable',
  'LayerTree.enable',
  'DOM.enable',
]) {
  try {
    // eslint-disable-next-line no-await-in-loop
    await session.send(method);
    console.log('ok', method);
  } catch (e) {
    console.log('fail', method, e.message);
  }
}

await sleep(1000);
try {
  const m = await session.send('Performance.getMetrics');
  console.log('metrics', m.metrics?.slice(0, 10));
} catch (e) {
  console.log('getMetrics', e.message);
}

try {
  const lt = await session.send('LayerTree.layerTreeChanged');
  console.log('layerTreeChanged', lt);
} catch (e) {
  console.log('layerTree', e.message);
}

session.close();
