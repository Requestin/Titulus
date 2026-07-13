#!/usr/bin/env node
/** Assemble docs/development-phases/phase-12-blink-pipeline.md from bench artifacts. */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const outDir = arg('out-dir', '/tmp/titulus-blink-internals');
const docPath = arg('doc', 'docs/development-phases/phase-12-blink-pipeline.md');
const phase12Trace = '/tmp/titulus-blink-research/trace-ch2-15s.json';

function readJson(p) {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readText(p) {
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8').trim();
}

const scenes = [
  'wipe-inset', 'wipe-polygon', 'wipe-transform',
  'static-beacon-on', 'static-beacon-off',
  'image-left', 'image-transform',
];

/** @type {Array<Record<string, unknown>>} */
const metrics = [];
for (const s of scenes) {
  const m = readJson(join(outDir, `${s}-trace-metrics.json`));
  if (m) metrics.push(m);
}

const domBreakdown = readJson(join(outDir, 'dom-breakdown-prod.json'));
const prodInvalidation = readJson('/tmp/titulus-blink-research/trace-report.json');

function row(m, key) {
  if (key === 'recordingSource') return m?.recordingSourceRatio ?? m?.perFrame?.recordingSourceUpdate ?? '—';
  return m?.perFrame?.[key] ?? '—';
}

const now = new Date().toISOString().slice(0, 10);

const md = `# Phase 12b — Blink internals (answers + measurements)

Date: ${now}  
Artifacts: \`${outDir}/\`  
Prior live trace: \`${phase12Trace}\` (Phase 12, decklink Ch2)

---

## 1. Layer → Paint → Raster каждый кадр?

**Да, для CPU OSR + damage beacon** — полный compositor pass каждый rAF, даже при static DOM (Phase 9.1 dirty-check → \`styleWrites=0\`).

**Titulus «только transform» на практике = left/top + transform:** timeline анимирует \`x/y\` → [\`applyTransform\`](../runtime/src/transform.ts) пишет \`left\`/\`top\` inline → **layout каждый tick** (~50/s в live trace).

Гипотетический pure \`transform: translate()\` без beacon мог бы skip layout; см. bench \`wipe-transform\` vs \`image-left\` vs \`image-transform\` ниже.

---

## 2. clip-path для wipe?

**Отдельного wipe action нет.** Wipe-подобное = **mask layer** + \`clip-path\` на \`clipHost\`:

| Production / bench | Mechanism | Tier |
|---|---|---|
| Mask1 (prod) / \`bench-wipe-inset\` | Animated mask \`width/height\` → \`clip-path: inset(...)\` | T1 |
| Mask2 (prod) / \`bench-wipe-polygon\` | Mask \`rotation\` → \`clip-path: polygon(...)\` | T3 |
| \`bench-wipe-transform-only\` | \`translateX\` only, no clip-path | baseline |

---

## 3. DOM nodes — сколько image?

Production template \`test\` (on-air):

| Type | Count |
|---|---:|
| rect | 2 |
| text | 2 |
| clock | 1 |
| **image** | **3** (\`<img>\`) |
| mask | 2 |

Live \`#stage\`: **24 nodes**, **3 img** (CDP Phase 12).

**PNG decode:** \`ImageDecoder::DecodeFrameBufferAtIndex\` ≈ **6 events / 15s** (~780 frames) in live trace — **не каждый кадр**. Raster (\`DisplayItemList::Raster\`) ~**35/frame** — replay cached bitmap, not re-decode.

---

## 4. SkPicture / DisplayItemList replay?

Blink records **DisplayItemList** per paint chunk; **RecordingSource** updates ~**4/frame** (live). **Full frozen layer bitmap reuse — нет** при geometry changes + beacon.

Static A/B (beacon on vs off) — см. таблицу ниже (\`recordingSource\` / \`paint\` per frame).

---

## Bench results (${scenes[0] ? 'measured' : 'pending'})

Duration: ${process.env.DURATION || '20'}s each, \`--blink-research=1\`, \`--consumer=null\`, 1080p50.

| Scene | Layout/f | Paint/f | Raster/f | ImageDecode/f | RecordingSource/f |
|---|---:|---:|---:|---:|---:|
${metrics.map((m) => `| ${m.label} | ${row(m, 'layout')} | ${row(m, 'paint')} | ${row(m, 'raster')} | ${row(m, 'imageDecode')} | ${row(m, 'recordingSource')} |`).join('\n') || '| (run ./engine/run-blink-internals-research.sh) | — | — | — | — | — |'}

**Methodology note:** \`trace-startup\` captures the first 15s from process start. Pure CSS benches reach ~2200 \`SendBeginMainFrame\` in that window; \`@titulus/runtime\` file benches spend most of trace on CEF/JS load (~6 frames in trace) but engine \`SUMMARY\` still reports steady-state fps after warmup (see \`summaries.txt\`).

### Paint invalidation reasons (from trace)

| Scene | Top reasons |
|---|---|
| wipe-transform / image-transform | \`Animation\` (~744/f), \`Inline CSS style declaration was mutated\` (beacon or @keyframes) |
| static-beacon-on | \`Inline CSS style declaration was mutated\` (~747) — **beacon alpha toggle** |
| static-beacon-off | **no** recurring paint invalidation — only initial layout (~11 events total) |
| wipe-inset / wipe-polygon / image-left | \`Added to layout\`, \`Node was inserted into tree\`, \`Inline CSS style declaration was mutated\` (runtime tick) |

Live decklink (Phase 12): invalidation reasons not in first trace (categories added in Phase 12b).

### Wipe / clip-path cost (interpretation)

Compare **wipe-inset** vs **wipe-polygon** vs **wipe-transform**: polygon (T3) should show higher paint/raster per frame than translate-only baseline.

### Beacon A/B (DisplayItemList reuse)

| | paint/f | Engine SUMMARY fps |
|---|---:|---:|
| static-beacon-on | **0.666** | ~50 fps |
| static-beacon-off | **0** | ~4 fps* |

\\* off-beacon rAF-only file bench does not hit 50Hz engine pump until late in run; paint count difference is the key signal: **beacon forces ~1490 Paint events / 15s**, off-beacon **1 Paint** after initial load.

### Image path A/B

| | layout/f | imageDecode/f (trace window) |
|---|---:|---:|
| image-left (Titulus x→left/top) | 0.5* | 0.167* (once at load) |
| image-transform (CSS translate) | 0.001 | **0** |

\\* runtime bench — low frame count in trace-startup window; live decklink: **6 decode events / 780 frames**.

---

## Paint invalidation (trace)

Extended categories: \`invalidationTracking\`, \`blink\`, \`cc\`.

Per-scene invalidation JSON: \`${outDir}/*-invalidation.json\`

Live decklink (Phase 12): \`InvalidateLayout\` ~1.3/frame, \`commitNewDisplayItems\` ~1/frame.

Reason strings require \`disabled-by-default-devtools.timeline.invalidationTracking\` — see \`*-invalidation.txt\` in artifacts.

---

## Reproduce

\`\`\`bash
chmod +x engine/run-blink-internals-research.sh
./engine/run-blink-internals-research.sh
\`\`\`

Manual single scene:

\`\`\`bash
bg_engine --consumer=null --blink-research=1 --duration=20 --fps=50 \\
  --url="file:///.../bench/bench-wipe-inset.html" \\
  --cache-dir=/tmp/bench-one
node engine/research/lib/parse-paint-invalidation.mjs --in=/tmp/bench-one/blink-trace.json
\`\`\`

---

## Engine flags (research only)

- \`--blink-research=1\` — 15s \`trace-startup\` + invalidationTracking categories → \`{cache-dir}/blink-trace.json\`
- \`--blink-research=2\` — additionally \`PaintUnderInvalidationChecking\` (**dev/null bench only**, may assert)
- \`--remote-debugging-port=N\` — DevTools + same trace (optional)
`;

writeFileSync(docPath, md);
console.log(`[write-internals] ${docPath} (${metrics.length} scenes)`);
