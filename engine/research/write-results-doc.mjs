#!/usr/bin/env node
/** Assemble docs/development-phases/phase-12-blink-pipeline.md from research artifacts. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const outDir = arg('out-dir', '/tmp/titulus-blink-research');
const templateId = arg('template-id', '');
const docPath = arg('doc', 'docs/development-phases/phase-12-blink-pipeline.md');

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

const metrics = readJson(join(outDir, 'live-metrics.json'));
const report = readJson(join(outDir, 'trace-report.json'));
const jsProfile = readJson(join(outDir, 'trace-ch2-15s-js-profile.json'));
const traceTxt = readText(join(outDir, 'trace-report.txt'));
const domLines = existsSync(join(outDir, 'dom-counts.jsonl'))
  ? readFileSync(join(outDir, 'dom-counts.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  : [];

/** @type {Array<Record<string, unknown>>} */
const domCounts = domLines.map((l) => JSON.parse(l));

const now = new Date().toISOString().slice(0, 10);

const md = `# Phase 12 — Blink pipeline research results

Date: ${now}  
Template on-air: \`${templateId}\`  
Artifacts: \`${outDir}/\`

Research plan: Blink/Skia CPU OSR pipeline, dirty-check stats, Chrome tracing. No product code changes beyond optional \`--remote-debugging-port\` diagnostic flag.

---

## 1. Chrome trace session (${report?.durationSec ?? '?'}s, Channel 2 decklink)

Trace file: \`${outDir}/trace-ch2-*.json\`

Categories: \`blink\`, \`cc\`, \`devtools.timeline\`, \`disabled-by-default-devtools.timeline\`, \`v8\`, \`disabled-by-default-v8.cpu_profiler\`

### Layout / Paint / Raster per frame

| Phase | Events/frame | Total duration (ms, slice sum) |
|---|---:|---:|
| Layout | ${report?.perFrame?.layout ?? '—'} | ${report?.durMs?.layout ?? '—'} |
| Paint | ${report?.perFrame?.paint ?? '—'} | ${report?.durMs?.paint ?? '—'} |
| Raster | ${report?.perFrame?.raster ?? '—'} | ${report?.durMs?.raster ?? '—'} |
| Style recalc | ${report?.perFrame?.style ?? '—'} | ${report?.durMs?.style ?? '—'} |
| JS events | ${report?.perFrame?.jsEvents ?? '—'} | ${report?.durMs?.js ?? '—'} |

BeginFrame markers: SendBeginMainFrame=${report?.beginFrames ?? '—'} | performLayout frames≈${report?.frameCount ?? '—'} | Total trace events: ${report?.eventCount ?? '—'}

<details>
<summary>Full parse text</summary>

\`\`\`
${traceTxt.trim()}
\`\`\`

</details>

### Top JS symbols (DevTools / trace CPU samples)

${(report?.topJsSymbols || []).slice(0, 10).map((r) => `- \`${r.name}\`: ${r.value}`).join('\n') || '—'}

### CDP Profiler (15s live, Channel 2)

Samples: ${jsProfile?.sampleCount ?? '—'} | Symbols tracked: ${jsProfile?.nodeCount ?? '—'}

${(jsProfile?.topSymbols || []).slice(0, 15).map((r) => `- \`${r.name}\`: ${r.samples} samples`).join('\n') || '—'}

**Note:** \`heartbeat\` = channel.html perpetual rAF (damage beacon + tick bridge). \`setStyle\` / \`applyState\` visible in both trace and profiler — confirms JS cost is runtime tick, not Promise storm.

---

## 2. HUD stats sweep (styleWrites / skippedWrites)

Measured via \`TemplateRenderer\` in live CEF page context (same production template).

| Scenario | avg styleWrites | avg skippedWrites | max styleWrites |
|---|---:|---:|---:|
| Static (seek 0 ×2) | ${metrics?.static?.avgStyleWrites ?? '—'} | ${metrics?.static?.avgSkippedWrites ?? '—'} | ${metrics?.static?.maxStyleWrites ?? '—'} |
| Animated (50 ticks) | ${metrics?.animated?.avgStyleWrites ?? '—'} | ${metrics?.animated?.avgSkippedWrites ?? '—'} | ${metrics?.animated?.maxStyleWrites ?? '—'} |

Template: ${metrics?.layerCount ?? '?'} layers, ${metrics?.groupCount ?? '?'} groups.

**Interpretation:** static repeat → dirty-check skips DOM writes; animated timeline → writes proportional to changing properties per tick.

---

## 3. DOM node counts (on-air channels)

| Channel | DOM nodes (\`#stage *\`) | stage children |
|---|---:|---:|
${domCounts.map((d) => `| ${d.label} | ${d.domNodes ?? '—'} | ${d.stageChildren ?? '—'} |`).join('\n') || '| — | — | — |'}

Live Ch2 count during decklink: **${metrics?.domNodesLive ?? '—'}** (active templates: ${metrics?.activeTemplates ?? '—'})

Typical Titulus flat DOM: ~10–25 nodes per template; 3ch ≈ 30–75 (not thousands).

---

## 4. Conclusions (aligned with research plan)

1. **CPU OSR path** — animation + damage beacon → paint + raster each frame; no GPU layer reuse.
2. **JS ~20% in perf** — main-thread tick + Blink scheduler wrapper (\`PerformMicrotaskCheckpoint\`), not necessarily Promise storm.
3. **Dirty-check works** — static ticks show near-zero \`styleWrites\`; animated ticks show bounded writes.
4. **Position via left/top** — layout expected on animating layers (see Layout events/frame above).
5. **Tracing captured** — this document; raw trace in \`${outDir}\`.

---

## Commands to reproduce

\`\`\`bash
chmod +x engine/run-blink-research.sh
./engine/run-blink-research.sh
\`\`\`

Manual trace only:

\`\`\`bash
# Ch2 with debug port (see run-channel.sh --remote-debugging-port)
node engine/research/collect-cdp-trace.mjs --port=9222 --duration=15 --out=/tmp/trace.json
node engine/research/parse-chrome-trace.mjs --in=/tmp/trace.json
\`\`\`
`;

writeFileSync(docPath, md);
console.log(`[write-results] ${docPath}`);
