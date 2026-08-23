export interface NumberNudgeOptions {
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly shift?: boolean;
}

const FINITE_DECIMAL =
  /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function clampFinite(value: number, min: number, max: number): number {
  const finiteValue = Number.isNaN(value)
    ? 0
    : value === Number.POSITIVE_INFINITY
      ? max
      : value === Number.NEGATIVE_INFINITY
        ? min
        : value;

  return Math.min(max, Math.max(min, finiteValue));
}

export function parseNumberDraft(draft: string): number | null {
  const text = draft.trim();
  if (!FINITE_DECIMAL.test(text)) return null;

  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) return '0';
  return String(value);
}

export function roundForStep(value: number, step: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;

  const quotient = value / step;
  if (!Number.isFinite(quotient)) return value;

  const rounded = Math.round(quotient) * step;
  return Number.isFinite(rounded)
    ? Number(rounded.toPrecision(15))
    : value;
}

export function nudgeNumber(
  value: number,
  direction: 1 | -1,
  options: NumberNudgeOptions,
): number {
  const multiplier = options.shift ? 10 : 1;
  const candidate = value + direction * options.step * multiplier;

  if (!Number.isFinite(candidate)) {
    return clampFinite(candidate, options.min, options.max);
  }

  return clampFinite(
    roundForStep(candidate, options.step),
    options.min,
    options.max,
  );
}

export function nudgeAngle45(value: number, direction: 1 | -1): number {
  return value + direction * 45;
}
