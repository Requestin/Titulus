#!/usr/bin/env node
/**
 * Live CDP metrics: DOM node count + RenderStats sweep (static vs animated).
 *
 * Usage:
 *   node engine/research/lib/collect-live-metrics.mjs \
 *     --port=9222 \
 *     --template=/tmp/template.json \
 *     --out=/tmp/live-metrics.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CdpSession, listTargets, pickRendererTarget } from './cdp-client.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const port = Number(arg('port', '9222'));
const templatePath = arg('template', '');
const outPath = arg('out', `/tmp/titulus-live-metrics-${Date.now()}.json`);

function statsSweepExpr(templateJson) {
  const tpl = JSON.stringify(templateJson);
  return `(async () => {
    const BG = window.BG;
    if (!BG || !BG.TemplateRenderer) throw new Error('window.BG.TemplateRenderer missing');

    const stageLive = document.querySelector('#stage');
    const domNodesLive = stageLive ? stageLive.querySelectorAll('*').length : 0;
    const activeCount = window.__titulus?.client?.activeCount?.() ?? null;

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1920px;height:1080px;visibility:hidden';
    document.body.appendChild(host);

    const tpl = ${tpl};
    const samples = [];

    function measure(label, fn) {
      const r = new BG.TemplateRenderer(host, {
        playbackMode: 'fixed',
        fixedTickRate: tpl.timeline?.fps || 50,
      });
      r.playTimeline(tpl, {}, {
        onFrame: (info) => { samples.push({ label, frame: info.frame, ...info.stats }); },
      });
      fn(r);
      host.innerHTML = '';
      return samples.filter((s) => s.label === label);
    }

    // Static: same frame twice — expect writes≈0 on 2nd seek
    const staticSamples = measure('static', (r) => {
      r.seek(0);
      r.seek(0);
    });

    // Animated: advance 50 ticks through timeline
    const animSamples = measure('animated', (r) => {
      for (let i = 0; i < 50; i++) r.tick();
    });

    document.body.removeChild(host);

    function summarize(arr) {
      if (!arr.length) return null;
      const last = arr[arr.length - 1];
      const writes = arr.map((s) => s.styleWrites);
      const skipped = arr.map((s) => s.skippedWrites);
      const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
      return {
        ticks: arr.length,
        last,
        avgStyleWrites: Number(avg(writes).toFixed(2)),
        avgSkippedWrites: Number(avg(skipped).toFixed(2)),
        maxStyleWrites: Math.max(...writes),
      };
    }

    return {
      domNodesLive,
      activeTemplates: activeCount,
      static: summarize(staticSamples),
      animated: summarize(animSamples),
      templateId: tpl.id,
      layerCount: (tpl.layers || []).length,
      groupCount: (tpl.groups || []).length,
    };
  })()`;
}

async function main() {
  if (!templatePath) throw new Error('--template= path to template JSON required');
  const templateJson = JSON.parse(readFileSync(templatePath, 'utf8'));
  const tplData = templateJson.data || templateJson;

  const targets = await listTargets(port);
  const target = pickRendererTarget(targets);
  console.log(`[metrics] target: ${target.url}`);

  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await session.send('Runtime.enable');

  const { result, exceptionDetails } = await session.evaluate(statsSweepExpr(tplData), true);
  if (exceptionDetails) {
    throw new Error(JSON.stringify(exceptionDetails));
  }

  const payload = result.value;
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`[metrics] domNodesLive=${payload.domNodesLive} active=${payload.activeTemplates}`);
  console.log(`[metrics] static: avgWrites=${payload.static?.avgStyleWrites} avgSkipped=${payload.static?.avgSkippedWrites}`);
  console.log(`[metrics] animated: avgWrites=${payload.animated?.avgStyleWrites} avgSkipped=${payload.animated?.avgSkippedWrites}`);
  console.log(`[metrics] wrote ${outPath}`);

  session.close();
}

main().catch((err) => {
  console.error('[metrics] FAILED:', err.message || err);
  process.exit(1);
});
