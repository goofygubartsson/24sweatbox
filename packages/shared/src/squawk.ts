// Stable per-callsign SSR code: 4 octal digits, never 7xxx (emergency/special), never the
// conspicuity codes 1000 / 2000, never 0000.
export function squawkFor(callsign: string): string {
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of callsign.toUpperCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = 0; i < 64; i++) {
    const v = (h + Math.imul(i, 0x9e3779b1)) >>> 0;
    const code = `${v % 7}${(v >>> 3) % 8}${(v >>> 6) % 8}${(v >>> 9) % 8}`;
    if (code !== "1000" && code !== "2000" && code !== "0000") return code;
  }
  return "4321";
}
