export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SizeBounds {
  readonly min: number;
  readonly max: number;
}

const FINITE_DECIMAL =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function nextSize(
  current: number,
  delta: number,
  bounds: SizeBounds,
): number {
  return clamp(current + delta, bounds.min, bounds.max);
}

export function readBooleanPreference(
  storage: StorageLike,
  key: string,
  fallback: boolean,
): boolean {
  try {
    const value = storage.getItem(key);
    if (value === '1') return true;
    if (value === '0') return false;
  } catch {
    // Storage can be unavailable because of browser privacy or quota policy.
  }

  return fallback;
}

export function writeBooleanPreference(
  storage: StorageLike,
  key: string,
  value: boolean,
): void {
  try {
    storage.setItem(key, value ? '1' : '0');
  } catch {
    // Preferences are best-effort and must not break editor interaction.
  }
}

export function readBoundedNumberPreference(
  storage: StorageLike,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const persisted = storage.getItem(key);
    if (persisted === null) return fallback;

    const text = persisted.trim();
    if (!FINITE_DECIMAL.test(text)) return fallback;

    const value = Number(text);
    return Number.isFinite(value) ? clamp(value, min, max) : fallback;
  } catch {
    return fallback;
  }
}

export function writeBoundedNumberPreference(
  storage: StorageLike,
  key: string,
  value: number,
  min: number,
  max: number,
): void {
  if (!Number.isFinite(value)) return;

  try {
    storage.setItem(key, String(clamp(value, min, max)));
  } catch {
    // Preferences are best-effort and must not break editor interaction.
  }
}

export function readAllowedStringPreference<T extends string>(
  storage: StorageLike,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    const value = storage.getItem(key);
    if (value !== null && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
  } catch {
    // Storage can be unavailable because of browser privacy or quota policy.
  }

  return fallback;
}

export function writeAllowedStringPreference<T extends string>(
  storage: StorageLike,
  key: string,
  allowed: readonly T[],
  value: T,
): void {
  if (!(allowed as readonly string[]).includes(value)) return;

  try {
    storage.setItem(key, value);
  } catch {
    // Preferences are best-effort and must not break editor interaction.
  }
}
