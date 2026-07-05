#!/usr/bin/env node
/**
 * DOM breakdown: total nodes, img count, layer types from CDP or template JSON.
 *
 * Usage:
 *   node engine/research/measure-dom-breakdown.mjs --port=9222
 *   node engine/research/measure-dom-breakdown.mjs --template=/path/template.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CdpSession, listTargets, pickRendererTarget } from './cdp-client.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const port = Number(arg('port', '0'));
const templatePath = arg('template', '');
const outPath = arg('out', '');

async function fromCdp(p) {
  const targets = await listTargets(p);
  const target = pickRendererTarget(targets);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await session.send('Runtime.enable');
  const { result, exceptionDetails } = await session.evaluate(`(() => {
    const stage = document.querySelector('#stage, #host, .titulus-root')?.closest('#stage')
      || document.querySelector('#stage')
      || document.querySelector('#host')
      || document.body;
    const root = stage.querySelector('.titulus-root') || stage;
    const all = root.querySelectorAll('*');
    const imgs = root.querySelectorAll('img');
    const videos = root.querySelectorAll('video');
    const clipHosts = root.querySelectorAll('[data-mask-clip]');
    return {
      domNodes: all.length,
      imgCount: imgs.length,
      videoCount: videos.length,
      clipHostCount: clipHosts.length,
      stageChildren: root.children.length,
      url: location.href,
    };
  })()`);
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
  session.close();
  return { source: 'cdp', port: p, ...result.value };
}

function fromTemplate(path) {
  const tpl = JSON.parse(readFileSync(path, 'utf8'));
  const data = tpl.data || tpl;
  const types = {};
  for (const l of data.layers || []) {
    types[l.type] = (types[l.type] || 0) + 1;
  }
  return {
    source: 'template',
    templateId: data.id,
    layerTypes: types,
    layerCount: (data.layers || []).length,
    groupCount: (data.groups || []).length,
    imgLayers: types.image || 0,
  };
}

async function main() {
  /** @type {Record<string, unknown>} */
  const report = { ts: new Date().toISOString() };
  if (templatePath) Object.assign(report, fromTemplate(templatePath));
  if (port > 0) Object.assign(report, await fromCdp(port));

  console.log(JSON.stringify(report, null, 2));
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
