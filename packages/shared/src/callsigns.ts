import { callsignData } from "./world";

// radio callsign (upper case) -> ICAO airline code, so real spoken names work too ("SPEEDBIRD-12")
const radioToIcao = new Map(Object.entries(callsignData.radio).map(([icao, radio]) => [radio.toUpperCase(), icao]));

export const CALLSIGN_RE = /^[A-Z0-9]{2,12}$/;

/**
 * Live data uses Roblox-style spoken callsigns ("Speedbird-123"); scripts use ICAO ("BAW123").
 * "Name-123" -> "<ICAO>123" when Name is a known spoof or radio name (case-insensitive); otherwise
 * the callsign is upper-cased with everything but letters and digits removed.
 */
export function normalizeCallsign(spoken: string): string {
  const s = spoken.trim();
  const m = /^(.*?)[\s-]+([A-Za-z0-9]+)$/.exec(s);
  if (m) {
    const name = m[1]!.trim();
    const icao = callsignData.spoof[name.toLowerCase()] ?? radioToIcao.get(name.toUpperCase());
    if (icao) return (icao + m[2]!.toUpperCase()).slice(0, 12);
  }
  const plain = s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return plain.length >= 2 ? plain : "UNKNOWN";
}

/** "BAW3847" -> "SPEEDBIRD 3847" (null when the airline is unknown). */
export function radioCallsign(callsign: string): string | null {
  const m = /^([A-Z]{3})(\w+)$/.exec(callsign.toUpperCase());
  if (!m) return null;
  const radio = callsignData.radio[m[1]!];
  return radio ? `${radio} ${m[2]}` : null;
}

export function airlineCodes(): string[] {
  return Object.keys(callsignData.radio).sort();
}
