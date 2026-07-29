// runtime/src/timeExpr.ts
//
// Operator-friendly time expressions → epoch ms (local timezone).
// Used by clock startTime/targetTime when bound to a `time` variable.
//
// Forms (no scripting):
//   Absolute:  2026-07-28T18:00:00 | 2026-07-28 18:00 | 1722175200000
//   Anchors:   today | tomorrow | yesterday | now
//   Day offset: today+1 | today-2 | tomorrow+1
//   Time-of-day: today@18:00 | today+1@09:30:00 | tomorrow@20:00
//   From now:  now+30s | now+5m | now+1h | now+1d

/** Resolve a time expression to epoch milliseconds. Returns undefined if empty/invalid. */
export function parseTimeExpression(
  expr: string | number | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (expr === null || expr === undefined) return undefined;
  if (typeof expr === 'number') {
    return Number.isFinite(expr) ? expr : undefined;
  }
  const raw = expr.trim();
  if (!raw) return undefined;

  // Pure epoch ms
  if (/^-?\d{11,15}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  const lower = raw.toLowerCase();

  // now / now±duration
  const nowRel = /^now([+-]\d+(?:\.\d+)?)([smhd])?$/.exec(lower);
  if (lower === 'now') return nowMs;
  if (nowRel) {
    const amount = Number(nowRel[1]);
    const unit = nowRel[2] || 's';
    const mult =
      unit === 's' ? 1000
        : unit === 'm' ? 60_000
          : unit === 'h' ? 3_600_000
            : 86_400_000; // d
    return nowMs + amount * mult;
  }

  // today / tomorrow / yesterday with optional ±days and optional @HH:MM[:SS]
  const anchor = /^(today|tomorrow|yesterday)([+-]\d+)?(?:@(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(lower);
  if (anchor) {
    const base = new Date(nowMs);
    base.setHours(0, 0, 0, 0);
    let dayOffset = 0;
    if (anchor[1] === 'tomorrow') dayOffset = 1;
    else if (anchor[1] === 'yesterday') dayOffset = -1;
    if (anchor[2]) dayOffset += Number(anchor[2]);
    base.setDate(base.getDate() + dayOffset);
    if (anchor[3] !== undefined) {
      base.setHours(
        Number(anchor[3]),
        Number(anchor[4]),
        anchor[5] !== undefined ? Number(anchor[5]) : 0,
        0,
      );
    }
    return base.getTime();
  }

  // ISO / "YYYY-MM-DD HH:MM[:SS]" / datetime-local
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  if (!Number.isNaN(parsed)) return parsed;

  return undefined;
}

/** Human hint for editors / Control placeholders. */
export const TIME_EXPR_HINT =
  'today@18:00 · today+1@09:30 · tomorrow · now+5m · 2026-07-28T20:00';
