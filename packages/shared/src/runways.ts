// Runway geometry helpers (spec section 5.4). Copy of the legacy logic, do not "fix" it:
//   dir = normalize(position2 - position1), invDir = -dir
//   appr(name1)   = { threshold: position1, out: invDir }   appr(name2)   = { threshold: position2, out: dir }
//   rwyEnd(name1) = { start: position1, end: position2, dir }   rwyEnd(name2) = { start: position2, end: position1, dir: invDir }
import cfg from "@sweatbox/config/public";
import { aviationAngle, dot, neg, normalize, perp, sub, type Vec, dist } from "./geometry";
import { runwayPairs, type RunwayPair } from "./world";

export interface RunwayEndRef {
  pair: RunwayPair;
  /** true when the end is name1 of the pair */
  first: boolean;
  /** "IRFD-25L" */
  name: string;
  icao: string;
  /** "25L" */
  designator: string;
}

const endIndex = new Map<string, RunwayEndRef>();
function indexPair(pair: RunwayPair) {
  for (const first of [true, false]) {
    const name = first ? pair.name1 : pair.name2;
    endIndex.set(name, { pair, first, name, icao: pair.icao, designator: name.split("-")[1]! });
  }
}
runwayPairs.forEach(indexPair);

/** Add a runway pair at runtime (tests use a synthetic airport). */
export function registerRunwayPair(pair: RunwayPair): void {
  if (!runwayPairs.includes(pair)) runwayPairs.push(pair);
  indexPair(pair);
}

/** Look up "IRFD-25L" (case-insensitive). */
export function findRunwayEnd(name: string): RunwayEndRef | undefined {
  return endIndex.get(name.toUpperCase());
}

export interface Approach {
  threshold: Vec;
  /** Unit vector from the threshold away from the runway, toward the approach. */
  out: Vec;
  /** Final approach course (heading flown on final). */
  course: number;
}

export function appr(end: RunwayEndRef): Approach {
  const { position1, position2 } = end.pair;
  const dir = normalize(sub(position2, position1));
  const out = end.first ? neg(dir) : dir;
  return { threshold: end.first ? position1 : position2, out, course: aviationAngle(neg(out)) };
}

/** Along-track distance (NM) from the threshold, positive on the approach side. */
export function alongTrackNm(a: Approach, pos: Vec): number {
  return dot(sub(pos, a.threshold), a.out) / cfg.sim.unitsPerNm;
}

/** Cross-track distance (map units, absolute) from the extended centreline. */
export function crossTrackUnits(a: Approach, pos: Vec): number {
  return Math.abs(dot(sub(pos, a.threshold), perp(a.out)));
}

/** Signed cross-track (map units), positive on the perp(out) side. */
export function crossTrackSigned(a: Approach, pos: Vec): number {
  return dot(sub(pos, a.threshold), perp(a.out));
}

export interface RunwayEndGeom {
  start: Vec;
  end: Vec;
  /** Takeoff / landing direction (unit vector). */
  dir: Vec;
  /** "07C/25C" in name1/name2 order, matching ground-map rwy strings. */
  pair: string;
  /** round(aviationAngle(dir)) % 360 */
  heading: number;
  length: number;
}

export function rwyEnd(end: RunwayEndRef): RunwayEndGeom {
  const { position1, position2 } = end.pair;
  const dir = normalize(sub(position2, position1));
  const start = end.first ? position1 : position2;
  const stop = end.first ? position2 : position1;
  const d = end.first ? dir : neg(dir);
  return {
    start,
    end: stop,
    dir: d,
    pair: end.pair.pair,
    heading: Math.round(aviationAngle(d)) % 360,
    length: dist(start, stop),
  };
}

/** True when a ground-map runway string ("07C/25C" or "25C/07C") names this pair. */
export function samePair(a: string, b: string): boolean {
  const [a1, a2] = a.toUpperCase().split("/");
  const [b1, b2] = b.toUpperCase().split("/");
  return (a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1);
}

/** True when a ground-map runway string contains this designator ("25L" in "07R/25L"). */
export function pairHasDesignator(pair: string, designator: string): boolean {
  return pair.toUpperCase().split("/").includes(designator.toUpperCase());
}
