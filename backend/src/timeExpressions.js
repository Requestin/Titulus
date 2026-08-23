const ANCHOR_RE = /^(today|tomorrow|yesterday)([+-]\d+)?(?:@(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const NOW_REL_RE = /^now([+-])(\d+)([smhd])?$/;
const EPOCH_RE = /^-?\d{11,15}$/;

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export function parseTimeExpression(expr, nowMs) {
  if (expr == null) return undefined;
  const raw = String(expr).trim();
  if (!raw) return undefined;
  if (EPOCH_RE.test(raw)) return Number(raw);
  if (raw === 'now') return nowMs;
  const rel = NOW_REL_RE.exec(raw);
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const amount = Number(rel[2]);
    const unit = rel[3] ?? 's';
    return nowMs + sign * amount * UNIT_MS[unit];
  }
  const anchor = ANCHOR_RE.exec(raw);
  if (anchor) {
    const base = new Date(nowMs);
    base.setHours(0, 0, 0, 0);
    let dayOffset = anchor[1] === 'tomorrow' ? 1 : anchor[1] === 'yesterday' ? -1 : 0;
    if (anchor[2]) dayOffset += Number(anchor[2]);
    base.setDate(base.getDate() + dayOffset);
    if (anchor[3] !== undefined) {
      base.setHours(Number(anchor[3]), Number(anchor[4]), Number(anchor[5] ?? 0), 0);
    }
    return base.getTime();
  }
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}
