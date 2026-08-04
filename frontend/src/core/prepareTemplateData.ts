// frontend/src/core/prepareTemplateData.ts
//
// Pre-TAKE / preview helper: crawl Use File + template.data pipeline.
// Runs on the control/editor side before WS take/update (backend is passthrough).

import {
  extractAssetId,
  isVariableExposed,
  resolveVariableMap,
  runTemplateData,
  type DataRunResult,
  type DataRunTrigger,
  type Template,
  type Variable,
} from '@runtime';
import { api } from '@/core/api';
import {
  crawlFileErrorMessage,
  CrawlFileError,
  readCrawlTextFile,
  templateForTake,
} from '@/core/crawlFile';
import { recomputeAllCrawlDirectors } from '@/editor/crawlTimeline';
import { ensureVideoClipsForVariables } from '@/editor/videoTimeline';

export class TemplateDataError extends Error {
  result: DataRunResult;

  constructor(result: DataRunResult) {
    const first = result.errors[0];
    super(first?.message || 'Template data pipeline failed');
    this.name = 'TemplateDataError';
    this.result = result;
  }
}

/** Read text/json for data sources (/uploads, http(s), or allow-listed path). */
export async function readTemplateDataFile(pathIn: string): Promise<string> {
  const path = pathIn.trim();
  if (!path) {
    throw new CrawlFileError('PATH_REQUIRED', 'File not found');
  }

  const lower = path.toLowerCase();
  const isJson = lower.endsWith('.json') || /\.json(\?|$)/i.test(path);
  const isTxt = lower.endsWith('.txt') || /\.txt(\?|$)/i.test(path);

  if (
    path.startsWith('/uploads/')
    || path.startsWith('http://')
    || path.startsWith('https://')
  ) {
    const res = await fetch(path.startsWith('/') ? path : path);
    if (!res.ok) {
      throw new CrawlFileError('FILE_NOT_FOUND', 'File not found');
    }
    if (!isTxt && !isJson) {
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/') && !ct.includes('json') && !ct.includes('javascript')) {
        throw new CrawlFileError(
          'UNSUPPORTED_FORMAT',
          'File format is not supported (txt or json)',
        );
      }
    }
    return res.text();
  }

  // Allow-listed local paths: reuse files API (backend accepts txt+json).
  try {
    const data = await api.files.read(path);
    return data.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|404|FILE_NOT_FOUND/i.test(msg)) {
      throw new CrawlFileError('FILE_NOT_FOUND', 'File not found');
    }
    if (/not supported|415|UNSUPPORTED/i.test(msg)) {
      throw new CrawlFileError(
        'UNSUPPORTED_FORMAT',
        'File format is not supported (txt or json)',
      );
    }
    throw new CrawlFileError('READ_FAILED', msg || 'File not found');
  }
}

export async function resolveMediaTokenForPipeline(
  token: string,
  _as: 'image' | 'video',
): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  const id = extractAssetId(trimmed);
  if (id) {
    try {
      const asset = await api.media.get(id);
      return asset.url || null;
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith('/uploads/')) {
    try {
      const asset = await api.media.lookup(trimmed);
      return asset.url || trimmed;
    } catch {
      return trimmed;
    }
  }

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

export interface PreparedAirPayload {
  template: Template;
  variables: Record<string, string | number>;
  dataResult: DataRunResult | null;
}

/**
 * Clone + crawl Use File + run template.data pipelines.
 * Throws CrawlFileError / TemplateDataError when policy is block.
 */
export async function prepareTemplateForAir(
  template: Template,
  operatorVars: Record<string, string | number>,
  trigger: DataRunTrigger = 'take',
): Promise<PreparedAirPayload> {
  const prepared = await templateForTake(template);
  const base = resolveVariableMap(prepared, operatorVars);

  if (!prepared.data) {
    await ensureVideoClipsForVariables(prepared, base);
    // Operator / default vars drive crawl length when content is variable-bound.
    recomputeAllCrawlDirectors(prepared, base);
    return { template: prepared, variables: base, dataResult: null };
  }

  // Prefer data-file reader (txt+json); fall back to crawl reader for .txt.
  const readFile = async (path: string) => {
    try {
      return await readTemplateDataFile(path);
    } catch (err) {
      if (err instanceof CrawlFileError && path.toLowerCase().endsWith('.txt')) {
        return readCrawlTextFile(path);
      }
      throw err;
    }
  };

  const dataResult = await runTemplateData(prepared, {
    trigger,
    variables: base,
    readFile,
    resolveMedia: resolveMediaTokenForPipeline,
  });

  const onError = prepared.data.onError ?? 'block';
  if (!dataResult.ok && onError === 'block') {
    throw new TemplateDataError(dataResult);
  }

  const variables = { ...base, ...dataResult.overrides };
  // Data-driven video src → create/update timeline clip; keep prior start if any.
  await ensureVideoClipsForVariables(prepared, variables);
  // After final variable map (incl. data overrides), refresh crawl director durations.
  recomputeAllCrawlDirectors(prepared, variables);

  return {
    template: prepared,
    variables,
    dataResult,
  };
}

export function templateDataErrorMessage(err: unknown): string {
  if (err instanceof TemplateDataError) return err.message;
  return crawlFileErrorMessage(err);
}

/** Filter operator-visible variables (hide driven unless exposed:true). */
export function exposedVariables(variables: Variable[]): Variable[] {
  return variables.filter((v) => isVariableExposed(v));
}
