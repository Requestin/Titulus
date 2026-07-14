// frontend/src/core/crawlFile.ts
// Shared Crawl Use File / Parse helpers for editor + control TAKE path.

import {
  estimateCrawlDurationFrames,
  resolveBinding,
  resolveVariableMap,
  splitCrawlLines,
  type CrawlLayer,
  type Template,
} from '@runtime';
import { api } from '@/core/api';

export class CrawlFileError extends Error {
  code: 'FILE_NOT_FOUND' | 'UNSUPPORTED_FORMAT' | 'PATH_REQUIRED' | 'READ_FAILED';

  constructor(
    code: CrawlFileError['code'],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'CrawlFileError';
  }
}

/** Read a .txt crawl source (upload URL or allow-listed filepath). */
export async function readCrawlTextFile(pathIn: string): Promise<string> {
  const path = pathIn.trim();
  if (!path) {
    throw new CrawlFileError('PATH_REQUIRED', 'File not found');
  }

  if (
    path.startsWith('/uploads/')
    || path.startsWith('http://')
    || path.startsWith('https://')
  ) {
    const res = await fetch(path.startsWith('/') ? path : path);
    if (!res.ok) {
      throw new CrawlFileError('FILE_NOT_FOUND', 'File not found');
    }
    const ct = res.headers.get('content-type') || '';
    if (!path.toLowerCase().endsWith('.txt') && !/\.txt(\?|$)/i.test(path)) {
      if (!ct.includes('text/plain') && !ct.includes('text/')) {
        throw new CrawlFileError(
          'UNSUPPORTED_FORMAT',
          'File format is not supported, supported only txt file',
        );
      }
    }
    return res.text();
  }

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
        'File format is not supported, supported only txt file',
      );
    }
    throw new CrawlFileError('READ_FAILED', msg || 'File not found');
  }
}

function recomputeCrawlDuration(template: Template, layer: CrawlLayer): void {
  const dir = template.timeline.directors.find((d) => d.id === layer.crawlDirectorId);
  if (!dir) return;
  const vars = resolveVariableMap(template);
  const raw = String(resolveBinding(layer.content, vars, ''));
  const lines = splitCrawlLines(raw, layer.crawl.maxTextLengthEnabled, layer.crawl.maxTextLength);
  const fps = template.timeline.fps || 50;
  dir.durationFrames = estimateCrawlDurationFrames({
    lines,
    crawl: layer.crawl,
    boxWidth: layer.transform.width,
    boxHeight: layer.transform.height,
    fontSize: layer.style.fontSize,
    fps,
    align: layer.style.align,
  });
  dir.loop = layer.crawl.animationType === 'continuous';
  dir.name = dir.name || 'Crawl';
  const end = dir.offsetFrames + dir.durationFrames;
  if (end > template.timeline.durationFrames) {
    template.timeline.durationFrames = end;
  }
}

/**
 * For every Crawl layer with Use File enabled, re-read filepath into
 * `layer.content` and refresh the Crawl director duration. Mutates `template`.
 */
export async function parseUseFileCrawlLayers(template: Template): Promise<Template> {
  for (const layer of template.layers) {
    if (layer.type !== 'crawl' || !layer.crawl.useFile) continue;
    const path = layer.crawl.filePath?.trim() ?? '';
    if (!path) {
      throw new CrawlFileError('PATH_REQUIRED', 'File not found');
    }
    const text = await readCrawlTextFile(path);
    layer.content = text;
    recomputeCrawlDuration(template, layer);
  }
  return template;
}

/** Clone template, parse all Use File crawl layers, return ready-to-TAKE payload. */
export async function templateForTake(template: Template): Promise<Template> {
  const clone = structuredClone(template);
  return parseUseFileCrawlLayers(clone);
}

export function crawlFileErrorMessage(err: unknown): string {
  if (err instanceof CrawlFileError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'File not found';
}
