// runtime/src/dataPipeline.ts
//
// Template-internal data pipeline: file → parse → select → map → variable overrides.
// Designer-owned; Control does not pick rows. Media tokens resolve via injected
// helpers (never by MAM displayName).
//
// MVP skeleton: lines / delimited / kv / json parse; select first|last|index|byKey|match|all;
// map + transforms; mediaResolve via ctx.resolveMedia (assetId|url|path, never displayName).

import type {
  DataMapAs,
  DataMapEntry,
  DataMissPolicy,
  DataPathRef,
  DataPipeline,
  DataRunTrigger,
  DataSelect,
  DataSource,
  DataSourceOptions,
  DataValueTransform,
  MediaResolvePolicy,
  Template,
  TemplateData,
  Variable,
} from './schema.js';

/** Normalized source row: all values stringified. */
export type DataRecord = Record<string, string>;

// ---------------------------------------------------------------------------
// Result / context
// ---------------------------------------------------------------------------

export interface DataPipelineError {
  code: string;
  message: string;
  sourceId?: string;
  pipelineId?: string;
}

export interface DataRunResult {
  ok: boolean;
  /** variableId → resolved value (merge into resolveVariableMap overrides). */
  overrides: Record<string, string | number>;
  errors: DataPipelineError[];
}

export interface DataRunContext {
  trigger: DataRunTrigger;
  /**
   * Current variable values (defaults + take/update overrides) used to resolve
   * `path: { type: 'variable' }` and as `keep` baseline.
   */
  variables: Record<string, string | number>;
  /** Read file contents for an absolute/relative allow-listed path or /uploads URL. */
  readFile: (path: string) => Promise<string>;
  /**
   * Resolve a media token from a mapped cell.
   * Accepts `asset:<uuid>`, bare uuid, http(s) URL, or `/uploads/...` path.
   * Must NOT silently resolve by displayName. Return null on miss.
   */
  resolveMedia?: (token: string, as: 'image' | 'video') => Promise<string | null>;
}

const DEFAULT_RUN_ON: DataRunTrigger[] = ['take', 'load'];
const ASSET_PREFIX = /^asset:/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Run all enabled pipelines on `template.data` for the given trigger.
 * No-op (ok, empty overrides) when `data` is absent or trigger not in `runOn`.
 */
export async function runTemplateData(
  template: Pick<Template, 'data' | 'variables'>,
  ctx: DataRunContext,
): Promise<DataRunResult> {
  const data = template.data;
  if (!data) {
    return { ok: true, overrides: {}, errors: [] };
  }

  const runOn = data.runOn?.length ? data.runOn : DEFAULT_RUN_ON;
  if (!runOn.includes(ctx.trigger)) {
    return { ok: true, overrides: {}, errors: [] };
  }

  const onError: DataMissPolicy | 'block' = data.onError ?? 'block';
  const overrides: Record<string, string | number> = {};
  const errors: DataPipelineError[] = [];
  const sourcesById = indexSources(data.sources);

  for (const pipeline of data.pipelines) {
    if (pipeline.enabled === false) continue;

    const source = sourcesById.get(pipeline.sourceId);
    if (!source) {
      errors.push({
        code: 'SOURCE_NOT_FOUND',
        message: `Pipeline "${pipeline.id}" references missing source "${pipeline.sourceId}"`,
        pipelineId: pipeline.id,
        sourceId: pipeline.sourceId,
      });
      if (shouldBlock(onError, pipeline.onEmpty)) {
        return fail(errors, onError, template.variables, data);
      }
      continue;
    }

    try {
      const raw = await loadSourceText(source, ctx);
      const records = parseSource(source, raw);
      const selected = selectRecords(records, pipeline.select);

      if (selected.length === 0) {
        const policy = pipeline.onEmpty ?? 'keep';
        errors.push({
          code: 'EMPTY_SELECTION',
          message: `Pipeline "${pipeline.id}" selected no records`,
          pipelineId: pipeline.id,
          sourceId: source.id,
        });
        if (policy === 'clear') clearMappedTargets(pipeline, overrides);
        if (policy === 'block') {
          return fail(errors, 'block', template.variables, data);
        }
        continue;
      }

      const mapped = await applyPipelineMaps(pipeline, selected, ctx);
      errors.push(...mapped.errors);
      if (!mapped.ok) {
        if (shouldBlock(onError, mapped.blockPolicy)) {
          return fail(errors, onError, template.variables, data);
        }
        continue;
      }
      Object.assign(overrides, mapped.overrides);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({
        code: 'PIPELINE_FAILED',
        message,
        pipelineId: pipeline.id,
        sourceId: source.id,
      });
      if (onError === 'block') {
        return fail(errors, onError, template.variables, data);
      }
      if (onError === 'clear') {
        clearMappedTargets(pipeline, overrides);
      }
    }
  }

  if (errors.length > 0 && onError === 'block') {
    return fail(errors, onError, template.variables, data);
  }

  return { ok: true, overrides, errors };
}

function fail(
  errors: DataPipelineError[],
  onError: DataOnErrorLike,
  variables: Variable[],
  data: TemplateData,
): DataRunResult {
  if (onError === 'keep') {
    return { ok: false, overrides: {}, errors };
  }
  if (onError === 'clear') {
    const cleared: Record<string, string | number> = {};
    for (const p of data.pipelines) clearMappedTargets(p, cleared);
    for (const v of variables) {
      if (v.drivenBy && cleared[v.id] === undefined) {
        cleared[v.id] = typeof v.defaultValue === 'number' ? 0 : '';
      }
    }
    return { ok: false, overrides: cleared, errors };
  }
  return { ok: false, overrides: {}, errors };
}

type DataOnErrorLike = 'block' | 'keep' | 'clear';

function shouldBlock(
  onError: DataOnErrorLike,
  local?: DataMissPolicy,
): boolean {
  if (local === 'block') return true;
  if (local === 'keep' || local === 'clear') return false;
  return onError === 'block';
}

function indexSources(sources: DataSource[]): Map<string, DataSource> {
  const map = new Map<string, DataSource>();
  for (const s of sources) map.set(s.id, s);
  return map;
}

function clearMappedTargets(
  pipeline: DataPipeline,
  overrides: Record<string, string | number>,
): void {
  for (const entry of pipeline.map) {
    if (entry.to.type === 'variable') overrides[entry.to.variableId] = '';
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export function resolveDataPath(
  path: DataPathRef,
  variables: Record<string, string | number>,
): string {
  if (path.type === 'literal') return path.value;
  const v = variables[path.variableId];
  if (v === undefined || v === null || v === '') {
    throw new Error(`Data path variable "${path.variableId}" is empty`);
  }
  return String(v);
}

async function loadSourceText(source: DataSource, ctx: DataRunContext): Promise<string> {
  if (source.type === 'inline') {
    if (typeof source.content !== 'string') {
      throw new Error(`Inline source "${source.id}" missing content`);
    }
    return source.content;
  }
  if (!source.path) {
    throw new Error(`Source "${source.id}" missing path`);
  }
  const path = resolveDataPath(source.path, ctx.variables);
  return ctx.readFile(path);
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseSource(source: DataSource, raw: string): DataRecord[] {
  const opts = normalizeOptions(source.options);
  switch (source.format) {
    case 'lines':
      return parseLines(raw, opts);
    case 'delimited':
      return parseDelimited(raw, opts);
    case 'kv':
      return parseKv(raw, opts);
    case 'json':
      return parseJson(raw, opts);
    default: {
      const _exhaustive: never = source.format;
      void _exhaustive;
      throw new Error(`Unsupported format: ${String(source.format)}`);
    }
  }
}

function normalizeOptions(options?: DataSourceOptions): Required<
  Pick<DataSourceOptions, 'skipEmpty' | 'trim'>
> &
  DataSourceOptions {
  return {
    skipEmpty: options?.skipEmpty !== false,
    trim: options?.trim !== false,
    encoding: options?.encoding ?? 'utf-8',
    commentPrefix: options?.commentPrefix,
    delimiter: options?.delimiter ?? '|',
    hasHeader: options?.hasHeader === true,
    columns: options?.columns,
    kvSeparator: options?.kvSeparator ?? '=',
    rootPath: options?.rootPath ?? '',
  };
}

function splitRawLines(raw: string, opts: DataSourceOptions): string[] {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: string[] = [];
  for (let line of lines) {
    if (opts.trim) line = line.trim();
    if (opts.commentPrefix && line.startsWith(opts.commentPrefix)) continue;
    if (opts.skipEmpty && line.length === 0) continue;
    out.push(line);
  }
  return out;
}

export function parseLines(raw: string, options?: DataSourceOptions): DataRecord[] {
  const opts = normalizeOptions(options);
  return splitRawLines(raw, opts).map((line, i) => ({
    line,
    index: String(i + 1),
  }));
}

export function parseDelimited(raw: string, options?: DataSourceOptions): DataRecord[] {
  const opts = normalizeOptions(options);
  const delim = opts.delimiter ?? '|';
  const rows = splitRawLines(raw, opts);
  if (rows.length === 0) return [];

  let columns = opts.columns ? [...opts.columns] : undefined;
  let start = 0;
  if (opts.hasHeader) {
    const header = rows[0]!.split(delim).map((c) => (opts.trim ? c.trim() : c));
    columns = columns ?? header;
    start = 1;
  }
  if (!columns || columns.length === 0) {
    const width = rows[0]!.split(delim).length;
    columns = Array.from({ length: width }, (_, i) => `col${i}`);
  }

  const records: DataRecord[] = [];
  for (let r = start; r < rows.length; r++) {
    const cells = rows[r]!.split(delim);
    const rec: DataRecord = { index: String(records.length + 1) };
    for (let c = 0; c < columns.length; c++) {
      let cell = cells[c] ?? '';
      if (opts.trim) cell = cell.trim();
      rec[columns[c]!] = cell;
    }
    records.push(rec);
  }
  return records;
}

export function parseKv(raw: string, options?: DataSourceOptions): DataRecord[] {
  const opts = normalizeOptions(options);
  const sep = opts.kvSeparator ?? '=';
  const rec: DataRecord = {};
  for (const line of splitRawLines(raw, opts)) {
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    let key = line.slice(0, idx);
    let value = line.slice(idx + sep.length);
    if (opts.trim) {
      key = key.trim();
      value = value.trim();
    }
    if (!key) continue;
    rec[key] = value;
  }
  return Object.keys(rec).length ? [rec] : [];
}

export function parseJson(raw: string, options?: DataSourceOptions): DataRecord[] {
  const opts = normalizeOptions(options);
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON: ${message}`);
  }

  const rooted = opts.rootPath ? getByPath(doc, opts.rootPath) : doc;

  if (Array.isArray(rooted)) {
    return rooted.map((item, i) => flattenToRecord(item, String(i + 1)));
  }
  if (rooted && typeof rooted === 'object') {
    return [flattenToRecord(rooted, '1')];
  }
  throw new Error('JSON root must be an object or array');
}

function getByPath(doc: unknown, path: string): unknown {
  if (!path) return doc;
  const parts = path.startsWith('/')
    ? path.split('/').filter(Boolean)
    : path.split('.').filter(Boolean);
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function flattenToRecord(item: unknown, index: string): DataRecord {
  const rec: DataRecord = { index };
  if (item === null || item === undefined) return rec;
  if (typeof item !== 'object' || Array.isArray(item)) {
    rec.value = String(item);
    return rec;
  }
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      rec[k] = '';
    } else if (typeof v === 'object') {
      // MVP: skip nested objects/arrays (keep flat schema)
      continue;
    } else {
      rec[k] = String(v);
    }
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export function selectRecords(records: DataRecord[], select: DataSelect): DataRecord[] {
  if (records.length === 0) return [];
  switch (select.mode) {
    case 'first':
      return records.slice(0, 1);
    case 'last':
      return records.slice(-1);
    case 'index': {
      const i = select.index - 1;
      if (i < 0 || i >= records.length) return [];
      return [records[i]!];
    }
    case 'byKey': {
      const hit = records.find((r) => r[select.key] === select.value);
      return hit ? [hit] : [];
    }
    case 'match': {
      let re: RegExp;
      try {
        re = new RegExp(select.pattern);
      } catch {
        throw new Error(`Invalid match pattern: ${select.pattern}`);
      }
      const hit = records.find((r) => re.test(r[select.key] ?? ''));
      return hit ? [hit] : [];
    }
    case 'all':
      return records;
    default: {
      const _exhaustive: never = select;
      void _exhaustive;
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Map + media
// ---------------------------------------------------------------------------

interface MapResult {
  ok: boolean;
  overrides: Record<string, string | number>;
  errors: DataPipelineError[];
  blockPolicy?: DataMissPolicy;
}

async function applyPipelineMaps(
  pipeline: DataPipeline,
  selected: DataRecord[],
  ctx: DataRunContext,
): Promise<MapResult> {
  const overrides: Record<string, string | number> = {};
  const errors: DataPipelineError[] = [];

  if (pipeline.select.mode === 'all') {
    return applyAllMaps(pipeline, selected, ctx);
  }

  const record = selected[0]!;
  for (const entry of pipeline.map) {
    const raw = record[entry.from] ?? '';
    const applied = await mapOneEntry(entry, raw, pipeline, ctx);
    if (!applied.ok) {
      errors.push({
        code: applied.code,
        message: applied.message,
        pipelineId: pipeline.id,
      });
      if (applied.block) {
        return { ok: false, overrides, errors, blockPolicy: 'block' };
      }
      continue;
    }
    overrides[entry.to.variableId] = applied.value!;
  }

  return { ok: true, overrides, errors };
}

async function applyAllMaps(
  pipeline: DataPipeline,
  selected: DataRecord[],
  ctx: DataRunContext,
): Promise<MapResult> {
  const overrides: Record<string, string | number> = {};
  const errors: DataPipelineError[] = [];

  // Prefer explicit join; else single map entry collects `from` with "\n".
  if (pipeline.join) {
    const sep = pipeline.join.separator ?? '\n';
    const joined = selected.map((r) => r[pipeline.join!.field] ?? '').join(sep);
    // Map join result onto every entry that targets variables (same text), or first entry only.
    const target = pipeline.map[0];
    if (!target) {
      return {
        ok: false,
        overrides,
        errors: [{ code: 'NO_MAP', message: 'Pipeline has join but empty map', pipelineId: pipeline.id }],
        blockPolicy: 'block',
      };
    }
    const applied = await mapOneEntry(target, joined, pipeline, ctx);
    if (!applied.ok) {
      errors.push({ code: applied.code, message: applied.message, pipelineId: pipeline.id });
      return { ok: false, overrides, errors, blockPolicy: applied.block ? 'block' : undefined };
    }
    overrides[target.to.variableId] = applied.value!;
    return { ok: true, overrides, errors };
  }

  if (pipeline.map.length !== 1) {
    return {
      ok: false,
      overrides,
      errors: [
        {
          code: 'ALL_NEEDS_JOIN_OR_SINGLE_MAP',
          message: 'select.mode "all" requires join or exactly one map entry',
          pipelineId: pipeline.id,
        },
      ],
      blockPolicy: 'block',
    };
  }

  const entry = pipeline.map[0]!;
  const joined = selected.map((r) => r[entry.from] ?? '').join('\n');
  const applied = await mapOneEntry(entry, joined, pipeline, ctx);
  if (!applied.ok) {
    errors.push({ code: applied.code, message: applied.message, pipelineId: pipeline.id });
    return { ok: false, overrides, errors, blockPolicy: applied.block ? 'block' : undefined };
  }
  overrides[entry.to.variableId] = applied.value!;
  return { ok: true, overrides, errors };
}

interface OneMapResult {
  ok: boolean;
  value?: string | number;
  code: string;
  message: string;
  block: boolean;
}

async function mapOneEntry(
  entry: DataMapEntry,
  raw: string,
  pipeline: DataPipeline,
  ctx: DataRunContext,
): Promise<OneMapResult> {
  let value = applyDataTransform(raw, entry.transform);
  const as: DataMapAs = entry.as ?? inferAs(entry);

  if (as === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        code: 'INVALID_NUMBER',
        message: `Cannot coerce "${value}" to number for ${entry.to.variableId}`,
        block: true,
      };
    }
    return { ok: true, value: n, code: '', message: '', block: false };
  }

  if (as === 'image' || as === 'video') {
    const policy = pipeline.mediaResolve ?? {
      strategy: ['assetId', 'url', 'path'] as const,
      onMiss: 'clear' as const,
    };
    const resolved = await resolveMediaToken(value, as, policy, ctx);
    if (resolved.ok) {
      return { ok: true, value: resolved.url, code: '', message: '', block: false };
    }
    const onMiss = policy.onMiss ?? 'clear';
    if (onMiss === 'keep') {
      return { ok: false, code: 'MEDIA_MISS', message: resolved.message, block: false };
    }
    if (onMiss === 'clear') {
      return { ok: true, value: policy.fallbackUrl ?? '', code: '', message: '', block: false };
    }
    return { ok: false, code: 'MEDIA_MISS', message: resolved.message, block: true };
  }

  // text / multitext / time (time stays as expression string for parseTimeExpression)
  return { ok: true, value, code: '', message: '', block: false };
}

function inferAs(entry: DataMapEntry): DataMapAs {
  void entry;
  return 'text';
}

export function applyDataTransform(value: string, transform?: DataValueTransform): string {
  if (!transform) return value;
  switch (transform.op) {
    case 'trim':
      return value.trim();
    case 'prefix':
      return `${transform.value}${value}`;
    case 'suffix':
      return `${value}${transform.value}`;
    case 'replace': {
      try {
        const re = new RegExp(transform.pattern, transform.flags ?? '');
        return value.replace(re, transform.replacement);
      } catch {
        return value;
      }
    }
    default: {
      const _exhaustive: never = transform;
      void _exhaustive;
      return value;
    }
  }
}

interface MediaResolveResult {
  ok: boolean;
  url: string;
  message: string;
}

/**
 * Classify and resolve a media cell token.
 * Does not look up by displayName.
 */
export async function resolveMediaToken(
  token: string,
  as: 'image' | 'video',
  policy: MediaResolvePolicy,
  ctx: DataRunContext,
): Promise<MediaResolveResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, url: '', message: 'Empty media token' };
  }

  for (const strategy of policy.strategy) {
    if (strategy === 'assetId') {
      const id = extractAssetId(trimmed);
      if (!id) continue;
      if (!ctx.resolveMedia) {
        return {
          ok: false,
          url: '',
          message: 'resolveMedia not provided in DataRunContext',
        };
      }
      const url = await ctx.resolveMedia(`asset:${id}`, as);
      if (url) return { ok: true, url, message: '' };
      continue;
    }
    if (strategy === 'url') {
      if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/uploads/')) {
        if (ctx.resolveMedia) {
          const url = await ctx.resolveMedia(trimmed, as);
          if (url) return { ok: true, url, message: '' };
        }
        // Pass-through URL/path when no resolver (editor preview / offline).
        return { ok: true, url: trimmed, message: '' };
      }
      continue;
    }
    if (strategy === 'path') {
      if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        if (ctx.resolveMedia) {
          const url = await ctx.resolveMedia(trimmed, as);
          if (url) return { ok: true, url, message: '' };
        }
        return { ok: true, url: trimmed, message: '' };
      }
    }
  }

  return {
    ok: false,
    url: '',
    message: `Cannot resolve media token "${trimmed}" (no displayName lookup)`,
  };
}

export function extractAssetId(token: string): string | null {
  const t = token.trim();
  if (ASSET_PREFIX.test(t)) {
    const id = t.replace(ASSET_PREFIX, '').trim();
    return UUID_RE.test(id) ? id : null;
  }
  return UUID_RE.test(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Helpers for Control / Editor
// ---------------------------------------------------------------------------

/** Variables that should be hidden from Control (driven or explicitly not exposed). */
export function isVariableExposed(v: Pick<Variable, 'exposed' | 'drivenBy'>): boolean {
  if (v.exposed === false) return false;
  if (v.drivenBy) return v.exposed === true;
  return true;
}
