// Separation: which pairs of airborne aircraft don't need the minimum (sim.sepLossNm / sepLossFt),
// so the separation-loss check doesn't report them.
import { config } from "@sweatbox/config";
import { angleDiff, appr, findRunwayEnd, samePair } from "@sweatbox/shared";
import type { Aircraft } from "./types";

const S = config.sim;

/** Both cleared for approaches to two parallel runways of one airport (independent parallel approaches). */
export function parallelApproaches(a: Aircraft, b: Aircraft): boolean {
  if (!a.approach || !b.approach || a.approach === b.approach) return false;
  const ea = findRunwayEnd(a.approach);
  const eb = findRunwayEnd(b.approach);
  if (!ea || !eb || ea.icao !== eb.icao || samePair(ea.pair.pair, eb.pair.pair)) return false;
  return Math.abs(angleDiff(appr(ea).course, appr(eb).course)) <= S.parallelRunwayMaxDeg;
}

/**
 * Parallel runway operations at one airport: a departure still on its initial climb (straight out,
 * below depJoinRouteAboveFt) and an aircraft approaching or landing on a parallel runway.
 */
function parallelRunwayOps(a: Aircraft, b: Aircraft): boolean {
  const departing = (x: Aircraft) => (x.dep && !x.dep.joined && x.altitude < S.depJoinRouteAboveFt ? findRunwayEnd(x.dep.rwy) : undefined);
  const landing = (x: Aircraft) => {
    const r = x.landing?.rwy ?? x.approach;
    return r ? findRunwayEnd(r) : undefined;
  };
  for (const [d, l] of [
    [departing(a), landing(b)],
    [departing(b), landing(a)],
  ])
    if (d && l && d.icao === l.icao && Math.abs(angleDiff(appr(d).course, appr(l).course)) <= S.parallelRunwayMaxDeg) return true;
  return false;
}

/** Two aircraft in the circuit of one airport: the tower separates them visually. */
const sameCircuit = (a: Aircraft, b: Aircraft): boolean => Boolean(a.cct && b.cct && a.cct.rwy.split("-")[0] === b.cct.rwy.split("-")[0]);

/** Pairs that don't need the separation minimum (and aren't reported as losses). */
export const separationExempt = (a: Aircraft, b: Aircraft): boolean =>
  parallelApproaches(a, b) || parallelRunwayOps(a, b) || sameCircuit(a, b);
