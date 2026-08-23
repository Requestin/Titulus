import { extractAssetId, runTemplateData } from './dataPipeline.js';
import { readAllowedText } from './filesAccess.js';
import { scheduleCrawl, syncCrawlProgressKeys } from './crawlSchedule.js';
import { mediaAssetsDao } from './db.js';

export function cloneTemplate(template) {
  return structuredClone(template);
}

export function resolvedCrawlText(template, layer) {
  const content = layer.content;
  if (typeof content === 'string') return content;
  const variable = (template.variables ?? []).find((item) => item.id === content?.variableId);
  return String(variable?.defaultValue ?? '');
}

export function applyVariableOverrides(template, overrides) {
  for (const variable of template.variables ?? []) {
    if (!Object.prototype.hasOwnProperty.call(overrides, variable.id)) continue;
    variable.defaultValue = overrides[variable.id];
  }
}

export function rebaseCrawlTimeline(template) {
  if (!template?.layers || !template.timeline) return template;
  for (const layer of template.layers) {
    if (layer.type !== 'crawl' || !layer.crawl) continue;
    const scheduled = scheduleCrawl({
      content: resolvedCrawlText(template, layer),
      fps: template.timeline.fps,
      box: { width: layer.transform.width, height: layer.transform.height },
      fontSize: layer.style?.fontSize ?? 32,
      align: layer.style?.align ?? 'left',
      crawl: layer.crawl,
    });
    const durationFrames = Math.max(1, scheduled.durationFrames);
    const director = (template.timeline.directors ?? []).find((item) => item.id === layer.crawlDirectorId);
    if (director) {
      director.durationFrames = durationFrames;
      director.loop = layer.crawl.animationType === 'continuous';
    }
    if (!template.timeline.keyframes) template.timeline.keyframes = [];
    syncCrawlProgressKeys(
      template.timeline.keyframes,
      layer.id,
      durationFrames,
      () => crypto.randomUUID(),
    );
  }
  return template;
}

async function ingestCrawlFiles(template, ctx, errors) {
  for (const layer of template.layers ?? []) {
    if (layer.type !== 'crawl' || !layer.crawl?.useFile || !layer.crawl.filePath) continue;
    try {
      const read = readAllowedText(layer.crawl.filePath, { dataDir: ctx.dataDir, env: ctx.env });
      if (typeof layer.content === 'string') {
        layer.content = read.text;
      } else {
        const variable = (template.variables ?? []).find((item) => item.id === layer.content?.variableId);
        if (variable) variable.defaultValue = read.text;
      }
    } catch (error) {
      errors.push({
        code: error.code || 'CRAWL_FILE',
        message: error.message || 'crawl file read failed',
        blocking: (template.data?.onError ?? 'block') === 'block' || error.status === 403,
      });
    }
  }
}

function resolveMediaToken(token, ctx) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  const assetId = extractAssetId(raw);
  if (assetId && ctx.db) {
    const row = mediaAssetsDao(ctx.db).get(assetId);
    if (row?.status === 'ready' && row.url) {
      return row.url;
    }
    return null;
  }
  if (/^https?:\/\//.test(raw) || raw.startsWith('/uploads/')) return raw;
  if (raw.startsWith('/')) return raw;
  return null;
}

export async function prepareTemplate(template, ctx = {}) {
  if (!template || typeof template !== 'object') {
    return { ok: false, blocked: true, overrides: {}, errors: [{ code: 'INVALID_TEMPLATE', message: 'template required', blocking: true }], template: null };
  }
  const snapshot = cloneTemplate(template);
  const errors = [];
  await ingestCrawlFiles(snapshot, ctx, errors);
  if (errors.some((item) => item.blocking)) {
    return { ok: false, blocked: true, overrides: {}, errors, template: snapshot };
  }

  const pipeline = await runTemplateData(snapshot, {
    trigger: ctx.trigger ?? 'take',
    variables: ctx.variables,
    nowMs: ctx.nowMs,
    readFile: async (path) => readAllowedText(path, { dataDir: ctx.dataDir, env: ctx.env }).text,
    resolveMedia: async (token) => resolveMediaToken(token, ctx),
  });
  errors.push(...pipeline.errors);

  if (pipeline.blocked) {
    return { ok: false, blocked: true, overrides: {}, errors, template: snapshot };
  }

  applyVariableOverrides(snapshot, pipeline.overrides);
  rebaseCrawlTimeline(snapshot);
  return {
    ok: pipeline.ok && errors.length === 0,
    blocked: false,
    overrides: pipeline.overrides,
    errors,
    template: snapshot,
  };
}
