import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_DATA_FILE_BYTES = 2 * 1024 * 1024;
export const ALLOWED_DATA_EXTS = new Set(['.txt', '.json', '.csv', '.tsv']);
export const ALLOWED_DATA_MIMES = new Set([
  'text/plain',
  'application/json',
  'text/csv',
  'text/tab-separated-values',
  'application/octet-stream',
]);

export function createAccessError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function managedDataFilesDir(dataDir) {
  return resolve(dataDir, 'data-files');
}

export function listFileRoots({ dataDir, env = process.env } = {}) {
  const managed = managedDataFilesDir(dataDir);
  const extra = String(env.TITULUS_FILE_ROOTS || '')
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => resolve(part));
  return [managed, ...extra];
}

function isInside(absPath, root) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return absPath === root || absPath.startsWith(prefix);
}

function canonicalizeExisting(absPath) {
  let st;
  try {
    st = lstatSync(absPath);
  } catch {
    throw createAccessError('FILE_NOT_FOUND', 'file not found', 404);
  }
  if (st.isSymbolicLink()) {
    throw createAccessError('PATH_NOT_ALLOWED', 'path is not allowed', 403);
  }
  if (!st.isFile()) {
    throw createAccessError('NOT_A_FILE', 'path is not a file', 400);
  }
  let real;
  try {
    real = realpathSync(absPath);
  } catch {
    throw createAccessError('FILE_NOT_FOUND', 'file not found', 404);
  }
  const realSt = lstatSync(real);
  if (realSt.isSymbolicLink() || !realSt.isFile()) {
    throw createAccessError('PATH_NOT_ALLOWED', 'path is not allowed', 403);
  }
  return { abs: real, stat: realSt };
}

function resolveCandidate(userPath, dataDir) {
  const raw = String(userPath ?? '').trim();
  if (!raw || raw.includes('\0')) {
    throw createAccessError('INVALID_PATH', 'invalid path', 400);
  }
  if (raw.startsWith('/data-files/') || raw === '/data-files' || raw.startsWith('data-files/')) {
    const rest = raw.replace(/^\/?data-files\/?/, '');
    return resolve(managedDataFilesDir(dataDir), rest);
  }
  if (!raw.startsWith('/') && !raw.startsWith('.')) {
    return resolve(managedDataFilesDir(dataDir), raw);
  }
  return resolve(raw);
}

export function resolveReadableFile(userPath, { dataDir, env = process.env } = {}) {
  const candidate = resolveCandidate(userPath, dataDir);
  const { abs, stat } = canonicalizeExisting(candidate);
  if (stat.size > MAX_DATA_FILE_BYTES) {
    throw createAccessError('FILE_TOO_LARGE', 'file too large', 413);
  }
  const roots = listFileRoots({ dataDir, env }).map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  });
  if (!roots.some((root) => isInside(abs, root))) {
    throw createAccessError('PATH_NOT_ALLOWED', 'path is not allowed', 403);
  }
  const ext = extname(abs).toLowerCase();
  if (!ALLOWED_DATA_EXTS.has(ext)) {
    throw createAccessError('UNSUPPORTED_FORMAT', 'file format is not supported', 415);
  }
  return { abs, size: stat.size, mtimeMs: stat.mtimeMs, ext };
}

export function readAllowedText(userPath, ctx) {
  const file = resolveReadableFile(userPath, ctx);
  const buffer = readFileSync(file.abs);
  if (buffer.includes(0)) {
    throw createAccessError('UNSUPPORTED_FORMAT', 'file format is not supported', 415);
  }
  const text = buffer.toString('utf8');
  return {
    text,
    lines: text.replace(/\r\n/g, '\n').split('\n'),
    size: file.size,
    mtimeMs: file.mtimeMs,
  };
}

export function writeManagedDataFile(buffer, originalName, { dataDir } = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw createAccessError('FILE_REQUIRED', 'file required', 400);
  }
  if (buffer.length > MAX_DATA_FILE_BYTES) {
    throw createAccessError('FILE_TOO_LARGE', 'file too large', 413);
  }
  if (buffer.includes(0)) {
    throw createAccessError('UNSUPPORTED_FORMAT', 'file format is not supported', 415);
  }
  const ext = (extname(originalName || '') || '').toLowerCase();
  if (!ALLOWED_DATA_EXTS.has(ext)) {
    throw createAccessError('UNSUPPORTED_EXTENSION', 'unsupported file extension', 415);
  }
  const dir = managedDataFilesDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const storedName = `${id}${ext}`;
  const abs = resolve(dir, storedName);
  writeFileSync(abs, buffer);
  return {
    id,
    originalName: basename(originalName || storedName),
    storedName,
    path: `/data-files/${storedName}`,
    size: buffer.length,
    abs,
  };
}

export function ensureDataFilesDir(dataDir) {
  mkdirSync(managedDataFilesDir(dataDir), { recursive: true });
  return managedDataFilesDir(dataDir);
}
