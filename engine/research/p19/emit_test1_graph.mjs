// engine/research/p19/emit_test1_graph.mjs
//
// POC helper: produce a `BGGRAPH v1 <json>` line for `tests/templates/test1.json`
// using the runtime operator-aware classifier + bounded protocol encoder.
// The bench in engine/bench/layered_compositor_bench.cpp consumes the file.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(
    path.dirname(path.dirname(url.fileURLToPath(import.meta.url))),
    '..', '..');

const templatePath = process.argv[2]
    ?? path.join(root, 'tests/templates/test1.json');
const outPath = process.argv[3]
    ?? path.join(root, 'engine/research/results/p19/doc02-20260715/graph/test1.bgraph');

const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

// Load the runtime source via a dynamic import against the prebuilt browser
// bundle. The bundle expects `window` to exist; we provide a minimal shim so
// the module loads under plain Node without tsx.
const bundlePath = path.join(root, 'backend/public/bg-runtime.js');
const bundleUrl = url.pathToFileURL(bundlePath).href;

if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}

await import(bundleUrl);
const mod = globalThis.window.BG ?? globalThis.BG;

const analysis = mod.classifyRenderGraph(template);
const layoutFromTemplate = (id) => {
    const layer = (template.layers ?? []).find((l) => l.id === id);
    if (!layer) return null;
    const t = layer.transform ?? {};
    const isMask = layer.type === 'mask';
    return {
        x: 0,
        y: 0,
        scale_x: t.scaleX ?? 1,
        scale_y: t.scaleY ?? 1,
        rotation_deg: t.rotation ?? 0,
        anchor_x: t.anchorX ?? 0,
        anchor_y: t.anchorY ?? 0,
        source_w: Math.round(t.width ?? template.canvas.width),
        source_h: Math.round(t.height ?? template.canvas.height),
        opacity: layer.opacity ?? 1,
        mask_mode: isMask ? (layer.maskMode === 'inverted' ? 'inverted' : 'normal') : 'none',
        mask_rect: isMask ? {
            x: Math.round(t.x ?? 0),
            y: Math.round(t.y ?? 0),
            w: Math.round(t.width ?? 0),
            h: Math.round(t.height ?? 0),
        } : undefined,
    };
};

const line = mod.encodeGraphSnapshot({
    revision: 1,
    analysis,
    resolveLayout: layoutFromTemplate,
});

if (!line) {
    console.error('emit_test1_graph: encoder rejected snapshot');
    process.exit(2);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, line + '\n');
console.log(`emit_test1_graph: wrote ${outPath} (${line.length} bytes, ${analysis.pixelSourceLayerIds.length + analysis.maskOperatorLayerIds.length} layers)`);
