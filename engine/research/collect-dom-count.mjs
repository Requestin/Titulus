#!/usr/bin/env node
/** DOM node count via CDP on live #stage. */
import { writeFileSync } from 'node:fs';
import { CdpSession, listTargets, pickRendererTarget } from './cdp-client.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const port = Number(arg('port', '9222'));
const label = arg('label', 'unknown');
const outPath = arg('out', '');

const targets = await listTargets(port);
const target = pickRendererTarget(targets);
const session = new CdpSession(target.webSocketDebuggerUrl);
await session.connect();
await session.send('Runtime.enable');

const { result, exceptionDetails } = await session.evaluate(`(() => {
  const stage = document.querySelector('#stage');
  if (!stage) return { error: 'no #stage' };
  return {
    domNodes: stage.querySelectorAll('*').length,
    stageChildren: stage.children.length,
    url: location.href,
  };
})()`);

if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));

const row = { label, port, ...result.value, ts: new Date().toISOString() };
const line = JSON.stringify(row);
console.log(line);
if (outPath) writeFileSync(outPath, line + '\n', { flag: 'a' });
session.close();
