import { airportRef, expandRoute, type Vec } from "@sweatbox/shared";
import { runwayChoices } from "./commands";
import { useScope } from "./store";
import type { RAircraft } from "./model";

/**
 * Route shown on the map for an aircraft: what it is flying (session), or its flight plan with the
 * SID expanded for the departure runway, ending at the destination.
 */
export function routeFor(a: RAircraft): { name: string; pos: Vec }[] {
  const out: { name: string; pos: Vec }[] = [];
  const dto = a.dto;
  if (dto && dto.fixPts.length) {
    dto.fixList.forEach((name, i) => out.push({ name, pos: { x: dto.fixPts[i]![0], y: dto.fixPts[i]![1] } }));
  } else if (a.fp) {
    const fp = a.fp;
    const st = useScope.getState().strips[a.callsign];
    const sid = st?.o_sid;
    const route = sid === "VIS" ? "" : sid ? `${sid} ${fp.route}` : fp.route;
    const runway = dto?.gnd?.rwy ?? runwayChoices(fp.departing, "dep")[0] ?? null;
    const ex = expandRoute(route, { dep: fp.departing, arr: fp.arriving, runway });
    out.push(...ex.points);
  }
  const destCode = a.arr;
  const dest = destCode ? airportRef(destCode) : null;
  if (dest && destCode && out[out.length - 1]?.name !== destCode) out.push({ name: destCode, pos: dest });
  return out;
}
