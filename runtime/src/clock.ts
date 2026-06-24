// runtime/src/clock.ts
//
// Clock/timer formatting for ClockLayer (DEVELOPMENT_PROMPT §6.2 clock).
//
// Tokens in `format` (strftime-like, deliberately small):
//   H  -> hours 0-23 (no pad)    HH -> 00-23
//   M  -> minutes 0-59           MM -> 00-59
//   S  -> seconds 0-59           SS -> 00-59
//   h  -> hours 1-12             hh -> 01-12
//   m  -> same as M
//   T  -> tenths of a second (0-9) — for countup/countdown granularity
// Literals are preserved. Example: "HH:mm:ss" -> "20:05:41"; "M:SS.T" -> "5:41.3".

export type ClockMode = 'clock' | 'countup' | 'countdown';

/** Compute the display text for a clock layer at a given epoch-ms `now`. */
export function formatClock(
  format: string,
  mode: ClockMode,
  now: number,
  opts: { startTime?: number; targetTime?: number } = {},
): string {
  let ms = now;
  if (mode === 'countup') {
    const start = opts.startTime ?? now;
    ms = Math.max(0, now - start);
  } else if (mode === 'countdown') {
    const target = opts.targetTime ?? now;
    ms = Math.max(0, target - now);
  }

  // countup/countdown express ms-as-a-duration; wall-clock uses the date.
  const totalSec = Math.floor(ms / 1000);
  const tenths = Math.floor((ms % 1000) / 100);
  let h24: number, h12: number, min: number, sec: number;
  if (mode === 'clock') {
    const d = new Date(ms);
    h24 = d.getHours();
    min = d.getMinutes();
    sec = d.getSeconds();
  } else {
    h24 = Math.floor(totalSec / 3600);
    min = Math.floor((totalSec % 3600) / 60);
    sec = totalSec % 60;
  }
  h12 = ((h24 + 11) % 12) + 1;

  const pad2 = (n: number) => String(n).padStart(2, '0');

  // Tokenize: greedy two-char first, then one-char, then literal.
  let out = '';
  for (let i = 0; i < format.length; ) {
    const two = format.substr(i, 2);
    const one = format[i];
    let replaced = false;
    if (two === 'HH') { out += pad2(h24); i += 2; replaced = true; }
    else if (two === 'MM' || two === 'mm') { out += pad2(min); i += 2; replaced = true; }
    else if (two === 'SS') { out += pad2(sec); i += 2; replaced = true; }
    else if (two === 'hh') { out += pad2(h12); i += 2; replaced = true; }
    else if (two === 'ss') { out += pad2(sec); i += 2; replaced = true; }
    else if (one === 'H') { out += String(h24); i += 1; replaced = true; }
    else if (one === 'h') { out += String(h12); i += 1; replaced = true; }
    else if (one === 'M' || one === 'm') { out += String(min); i += 1; replaced = true; }
    else if (one === 'S' || one === 's') { out += String(sec); i += 1; replaced = true; }
    else if (one === 'T') { out += String(tenths); i += 1; replaced = true; }
    if (!replaced) { out += one; i += 1; }
  }
  return out;
}
