import cfg from "@sweatbox/config/public";
import type { Wake } from "./dataTypes";
import { aircraftData } from "./world";

const gaRegex = new RegExp(cfg.circuit.gaTypeRegex);

/** Light GA type flown in the GA circuit (and wake L when the type is unknown). */
export function isGaType(icao: string): boolean {
  return gaRegex.test(icao.toUpperCase());
}

/**
 * Roblox aircraft name -> ICAO designator ("Boeing 737" -> "B738", "Boeing 737 Cargo" -> "B738").
 * A name that already is a known ICAO designator is returned as is.
 */
export function robloxToIcao(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+cargo$/, "");
  const hit = aircraftData.types[key];
  if (hit) return hit;
  const upper = name.trim().toUpperCase();
  if (aircraftData.info[upper] || /^[A-Z][A-Z0-9]{1,3}$/.test(upper)) return upper;
  return "ZZZZ";
}

/** Wake category. Never undefined: unknown GA types are L, anything else unknown is M. */
export function wakeOf(icao: string): Wake {
  const info = aircraftData.info[icao.toUpperCase()];
  if (info) return info.wake;
  return isGaType(icao) ? "L" : "M";
}

export function lengthMetres(icao: string): number {
  return aircraftData.info[icao.toUpperCase()]?.lengthM ?? cfg.ground.defaultLengthM;
}

/** Aircraft length in map units (for ground spacing). */
export function lengthUnits(icao: string): number {
  return lengthMetres(icao) / cfg.ground.metresPerUnit;
}

export function knownTypes(): string[] {
  return Object.keys(aircraftData.info).sort();
}
