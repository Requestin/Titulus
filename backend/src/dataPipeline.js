import { parseTimeExpression } from './timeExpressions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_RE = /^[^/:]+$/;

export function resolveDataPath(path, variables = {}) {
  if (!path || typeof path !== 'object') return '';
  if (path.type === 'literal') return String(path.value ?? '');
  if (path.type === 'variable') return String(variables[path.variableId] ?? '');
  return '';
}

export function extractAssetId(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('asset:')) {
    const id = raw.slice('asset:'.length);
    return UUID_RE.test(id) ? id : null;
  }
  return UUID_RE.test(raw) ? raw : null;
}

export function applyDataTransform(value, transform) {
  const text = String(value ?? '');
  if (!transform) return text;
  if (transform.op === 'trim') return text.trim();
  if (transform.op === 'prefix') return `${transform.value ?? ''}${text}`;
  if (transform.op === 'suffix') return `${text}${transform.value ?? ''}`;
  if (transform.op === 'replace') {
    const flags = typeof transform.flags === 'string' && /^[dgimsuvy]*$/.test(transform.flags)
      ? transform.flags
      : '';
    return text.replace(new RegExp(transform.pattern, flags), transform.replacement ?? '');
  }
  return text;
}

export function parseSource(source, raw) {
  const options = source.options ?? {};
  const skipEmpty = options.skipEmpty !== false;
  const trim = options.trim !== false;
  const commentPrefix = options.commentPrefix;
  const lines = String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const next = trim ? line.trim() : line;
    if (skipEmpty && next === '') continue;
    if (commentPrefix && next.startsWith(commentPrefix)) continue;
    kept.push(next);
  }
  if (source.format === 'lines') {
    return kept.map((line, index) => ({ line, index: String(index + 1) }));
  }
  if (source.format === 'delimited') {
    const delimiter = options.delimiter ?? '|';
    let columns = options.columns ? [...options.columns] : null;
    const rows = kept.map((line) => line.split(delimiter));
    if (!columns && options.hasHeader && rows.length > 0) {
      columns = rows.shift().map((cell, index) => cell || `col${index}`);
    }
    return rows.map((cells, index) => {
      const record = { index: String(index + 1) };
      cells.forEach((cell, cellIndex) => {
        record[columns?.[cellIndex] ?? `col${cellIndex}`] = cell;
      });
      return record;
    });
  }
  if (source.format === 'kv') {
    const sep = options.kvSeparator ?? '=';
    const record = { index: '1' };
    for (const line of kept) {
      const at = line.indexOf(sep);
      if (at < 0) continue;
      record[line.slice(0, at)] = line.slice(at + sep.length);
    }
    return [record];
  }
  if (source.format === 'json') {
    const parsed = JSON.parse(String(raw ?? ''));
    const rooted = takeRoot(parsed, options.rootPath ?? '');
    if (Array.isArray(rooted)) {
      return rooted.map((item, index) => flattenJsonRecord(item, String(index + 1)));
    }
    if (rooted && typeof rooted === 'object') {
      return [flattenJsonRecord(rooted, '1')];
    }
    throw new Error('JSON source must be an object or array');
  }
  throw new Error(`unsupported source format: ${source.format}`);
}

function takeRoot(value, rootPath) {
  if (!rootPath) return value;
  const parts = rootPath.startsWith('/')
    ? rootPath.split('/').filter(Boolean)
    : rootPath.split('.').filter(Boolean);
  return parts.reduce((acc, key) => acc?.[key], value);
}

function flattenJsonRecord(item, index) {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) {
    return { value: item == null ? '' : String(item), index };
  }
  const record = { index };
  for (const [key, value] of Object.entries(item)) {
    if (value != null && typeof value === 'object') continue;
    record[key] = value == null ? '' : String(value);
  }
  return record;
}

export function selectRecords(records, select) {
  if (!select || select.mode === 'first') return records.slice(0, 1);
  if (select.mode === 'last') return records.slice(-1);
  if (select.mode === 'index') return records.filter((record) => Number(record.index) === select.index);
  if (select.mode === 'byKey') return records.filter((record) => record[select.key] === select.value);
  if (select.mode === 'match') {
    const re = new RegExp(select.pattern);
    return records.filter((record) => re.test(String(record[select.key] ?? '')));
  }
  if (select.mode === 'all') return [...records];
  return [];
}

export async function runTemplateData(template, ctx) {
  const data = template?.data;
  const trigger = ctx.trigger ?? 'take';
  const nowMs = ctx.nowMs ?? Date.now();
  const variables = { ...collectDefaults(template), ...ctx.variables };
  if (!data) return { ok: true, overrides: {}, errors: [] };
  const runOn = data.runOn?.length ? data.runOn : ['take', 'load'];
  if (!runOn.includes(trigger)) return { ok: true, overrides: {}, errors: [] };

  const errors = [];
  const overrides = {};
  const onError = data.onError ?? 'block';
  const sources = new Map((data.sources ?? []).map((source) => [source.id, source]));

  for (const pipeline of data.pipelines ?? []) {
    if (pipeline.enabled === false) continue;
    try {
      const source = sources.get(pipeline.sourceId);
      if (!source) {
        errors.push(error('SOURCE_NOT_FOUND', `source ${pipeline.sourceId} is missing`, pipeline, onError === 'block'));
        continue;
      }
      const raw = source.type === 'inline'
        ? source.content
        : await ctx.readFile(resolveDataPath(source.path, variables));
      const records = parseSource(source, raw);
      const selected = selectRecords(records, pipeline.select);
      if (selected.length === 0) {
        applyEmpty(pipeline, template, overrides, errors);
        continue;
      }
      await applyMaps(pipeline, selected, overrides, errors, { ...ctx, nowMs, onError });
    } catch (err) {
      errors.push(error(
        'PIPELINE_FAILED',
        err instanceof Error ? err.message : 'pipeline failed',
        pipeline,
        onError === 'block',
      ));
    }
  }

  if (errors.length === 0) return { ok: true, overrides, errors };
  if (errors.some((item) => item.blocking) || onError === 'block') {
    return { ok: false, blocked: true, overrides: {}, errors };
  }
  if (onError === 'clear') {
    clearFailedTargets(template, errors, overrides);
    return { ok: false, blocked: false, overrides, errors };
  }
  return { ok: false, blocked: false, overrides: {}, errors };
}

function collectDefaults(template) {
  const values = {};
  for (const variable of template.variables ?? []) values[variable.id] = variable.defaultValue;
  return values;
}

function applyEmpty(pipeline, template, overrides, errors) {
  const policy = pipeline.onEmpty ?? 'keep';
  if (policy === 'keep') return;
  if (policy === 'clear') {
    for (const entry of pipeline.map ?? []) {
      overrides[entry.to.variableId] = typedEmpty(template, entry);
    }
    return;
  }
  errors.push(error('EMPTY_SELECTION', `pipeline ${pipeline.id} selected no rows`, pipeline, true));
}

async function applyMaps(pipeline, selected, overrides, errors, ctx) {
  const maps = pipeline.map ?? [];
  if (pipeline.select?.mode === 'all' && pipeline.join) {
    const joined = selected.map((record) => record[pipeline.join.field] ?? '').join(pipeline.join.separator ?? '\n');
    if (!maps[0]) {
      errors.push(error('NO_MAP', 'pipeline has no map', pipeline, true));
      return;
    }
    await writeMap(maps[0], joined, overrides, errors, pipeline, ctx);
    return;
  }
  if (pipeline.select?.mode === 'all') {
    if (maps.length !== 1) {
      errors.push(error('ALL_NEEDS_JOIN_OR_SINGLE_MAP', 'select all needs join or a single map', pipeline, true));
      return;
    }
    await writeMap(maps[0], selected.map((record) => record[maps[0].from] ?? '').join('\n'), overrides, errors, pipeline, ctx);
    return;
  }
  for (const entry of maps) {
    await writeMap(entry, selected[0]?.[entry.from] ?? '', overrides, errors, pipeline, ctx);
  }
}

async function writeMap(entry, rawValue, overrides, errors, pipeline, ctx) {
  const transformed = applyDataTransform(rawValue, entry.transform);
  const as = entry.as ?? 'text';
  const target = entry.to.variableId;
  if (as === 'number') {
    const number = Number(transformed);
    if (!Number.isFinite(number)) {
      errors.push(error('INVALID_NUMBER', `invalid number: ${transformed}`, pipeline, ctx.onError === 'block'));
      return;
    }
    overrides[target] = number;
    return;
  }
  if (as === 'time') {
    if (parseTimeExpression(transformed, ctx.nowMs) == null) {
      errors.push(error('INVALID_TIME', `invalid time: ${transformed}`, pipeline, ctx.onError === 'block'));
      return;
    }
    overrides[target] = transformed;
    return;
  }
  if (as === 'image' || as === 'video') {
    const resolved = await resolveMappedMedia(transformed, as, pipeline, ctx);
    if (resolved.status === 'ok') {
      overrides[target] = resolved.value;
      return;
    }
    errors.push(error('MEDIA_MISS', resolved.message, pipeline, resolved.action === 'block'));
    if (resolved.action === 'clear') overrides[target] = pipeline.mediaResolve?.fallbackUrl ?? '';
    return;
  }
  overrides[target] = transformed;
}

async function resolveMappedMedia(token, as, pipeline, ctx) {
  const policy = pipeline.mediaResolve ?? { strategy: ['assetId', 'url', 'path'], onMiss: 'clear' };
  const raw = String(token ?? '').trim();
  if (raw && DISPLAY_NAME_RE.test(raw) && !extractAssetId(raw) && !raw.startsWith('asset:')) {
    return { status: 'miss', action: 'block', message: 'display-name media tokens are forbidden' };
  }
  if (ctx.resolveMedia) {
    const value = await ctx.resolveMedia(raw, as, policy);
    if (value != null) return { status: 'ok', value };
  } else if (raw) {
    return { status: 'ok', value: raw };
  }
  return { status: 'miss', action: policy.onMiss ?? 'clear', message: `media miss: ${raw}` };
}

function typedEmpty(template, entry) {
  const variable = (template.variables ?? []).find((item) => item.id === entry.to.variableId);
  if (variable?.type === 'number' || entry.as === 'number') return 0;
  return '';
}

function clearFailedTargets(template, errors, overrides) {
  const failed = new Set(errors.map((item) => item.pipelineId).filter(Boolean));
  for (const pipeline of template.data?.pipelines ?? []) {
    if (!failed.has(pipeline.id)) continue;
    for (const entry of pipeline.map ?? []) {
      overrides[entry.to.variableId] = typedEmpty(template, entry);
    }
  }
  for (const variable of template.variables ?? []) {
    if (!variable.drivenBy || overrides[variable.id] !== undefined) continue;
    overrides[variable.id] = variable.type === 'number' ? 0 : '';
  }
}

function error(code, message, pipeline, blocking) {
  return {
    code,
    message,
    pipelineId: pipeline?.id,
    sourceId: pipeline?.sourceId,
    blocking: Boolean(blocking),
  };
}
