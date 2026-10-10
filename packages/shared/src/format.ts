// Small formatting / parsing helpers shared by the UI and the server.

/**
 * Controller altitude input -> feet. "80" / "FL80" / "F080" = flight level 80 = 8000 ft;
 * "8000" = feet. Plain numbers under 1000 are flight levels. Returns null when unparseable.
 */
export function parseAltitudeInput(raw: string): number | null {
  const s = raw.trim().toUpperCase();
  const fl = /^F(?:L)?\s*(\d{1,3})$/.exec(s);
  if (fl) return Number(fl[1]) * 100;
  if (/^A\d{1,5}$/.test(s)) return Number(s.slice(1));
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n < 1000 ? n * 100 : n;
}

/** 3000 -> "030", 35000 -> "350" (hundreds of feet, three digits). */
export function hundreds(ft: number): string {
  return String(Math.max(0, Math.round(ft / 100))).padStart(3, "0");
}

/** Requested flight level string "040" from feet or a script RFL token ("FL040", "40", "040"). */
export function flightLevelString(rfl: string | number): string {
  if (typeof rfl === "number") return hundreds(rfl);
  const digits = rfl.toUpperCase().replace(/^FL?/, "");
  return /^\d{1,3}$/.test(digits) ? digits.padStart(3, "0") : rfl.toUpperCase();
}

export function pad2(n: number): string {
  return String(Math.floor(n)).padStart(2, "0");
}

/** Script clock: 312 -> "05:12", 3725 -> "1:02:05". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

/** "14:05:09Z" */
export function formatUtc(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

export function heading3(h: number): string {
  const r = Math.round(((h % 360) + 360) % 360);
  return String(r === 0 ? 360 : r).padStart(3, "0");
}

/** "1h 05m" / "12m" / "40s" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}
