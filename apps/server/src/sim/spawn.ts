// Creating aircraft (SPAWN / DEP / GATE) and the departure route join (spec 5.5).
import crypto from "node:crypto";
import { config } from "@sweatbox/config";
import {
  add,
  airportRef,
  angleDiff,
  aviationAngle,
  bearing,
  dist,
  expandRoute,
  findRunwayEnd,
  isSidToken,
  routeHeading,
  routeTokens,
  rwyEnd,
  scale,
  wakeOf,
  type Vec,
} from "@sweatbox/shared";
import type { Aircraft } from "./types";
import type { SimContext } from "./context";
import { parkAtStand, stripClimb } from "./ground";

const S = config.sim;

export function blankAircraft(cs: string, type: string, pos: Vec): Aircraft {
  return {
    id: crypto.randomUUID(),
    callsign: cs,
    type,
    wake: wakeOf(type),
    pos: { ...pos },
    heading: 0,
    altitude: 0,
    groundSpeed: 0,
    verticalSpeed: 0,
    trail: [],
    onGround: false,
    emergency: false,
    emergencyCounted: false,
    assigned: { alt: 0, heading: 360, speed: 0 },
    fixList: [],
    approach: null,
    apprCaptured: false,
    landClr: false,
    cct: null,
    cctAfterTakeoff: null,
    hold: null,
    dep: null,
    homing: false,
    arr: null,
    gnd: null,
    landing: null,
    fp: { callsign: cs, aircraft: type, flightRules: "IFR", departing: "", arriving: "", route: "", flightLevel: "000", sid: null },
    vsRef: { alt: 0, sim: 0 },
    scriptTag: null,
    gone: false,
  };
}

/** First SID token in a route, for the flight plan / strip. */
function sidOf(dep: string, route: string): string | null {
  return routeTokens(route).find((t) => isSidToken(dep, t)) ?? null;
}

export function spawnAirborne(
  cs: string,
  type: string,
  o: { alt: number; rfl: string; gs: number; route: string; dep: string; arr: string; x: number; y: number },
): Aircraft {
  const ac = blankAircraft(cs, type, { x: o.x, y: o.y });
  ac.altitude = o.alt;
  ac.groundSpeed = o.gs;
  const hdg = routeHeading(o.route);
  if (hdg !== null) {
    ac.heading = hdg % 360;
  } else {
    const ex = expandRoute(o.route, { dep: o.dep, arr: o.arr });
    ac.fixList = ex.points;
    const first = ex.points[0]?.pos ?? airportRef(o.arr);
    ac.heading = first ? bearing(ac.pos, first) : 0;
    ac.homing = o.arr !== o.dep;
  }
  ac.assigned = { alt: o.alt, heading: Math.round(ac.heading) || 360, speed: o.gs };
  ac.arr = o.arr;
  ac.fp = { callsign: cs, aircraft: type, flightRules: "IFR", departing: o.dep, arriving: o.arr, route: o.route, flightLevel: o.rfl, sid: sidOf(o.dep, o.route) };
  ac.vsRef = { alt: o.alt, sim: 0 };
  return ac;
}

/** DEP: airborne off the runway, 60% down it, 200 ft, 160 kt, runway heading. */
export function spawnDeparture(
  cs: string,
  type: string,
  o: { runway: string; climb: number; rfl: string; route: string; arr: string; spd: number },
): Aircraft | null {
  const end = findRunwayEnd(o.runway);
  if (!end) return null;
  const g = rwyEnd(end);
  const ac = blankAircraft(cs, type, add(g.start, scale(g.dir, g.length * S.depSpawnRunwayFraction)));
  ac.heading = aviationAngle(g.dir);
  ac.altitude = S.depInitialAltFt;
  ac.groundSpeed = S.depInitialSpeedKt;
  ac.assigned = { alt: o.climb, heading: Math.round(ac.heading) || 360, speed: o.spd };
  ac.dep = { rwy: end.name, route: o.route, joined: false, overridden: false };
  ac.arr = o.arr;
  ac.fp = { callsign: cs, aircraft: type, flightRules: "IFR", departing: end.icao, arriving: o.arr, route: o.route, flightLevel: o.rfl, sid: sidOf(end.icao, o.route) };
  ac.vsRef = { alt: ac.altitude, sim: 0 };
  return ac;
}

/** GATE / STAND: parked nose-in. Route CCT (with RFL 010) is a local VFR circuit flight. */
export function spawnAtGate(
  cs: string,
  type: string,
  o: { apt: string; stand: string; rfl: string; route: string; arr: string },
  ctx: SimContext,
): Aircraft | null {
  const ac = blankAircraft(cs, type, { x: 0, y: 0 });
  if (!parkAtStand(ac, o.apt, o.stand, ctx)) return null;
  const vfr = o.route.toUpperCase() === "CCT" || o.route.toUpperCase() === "VIS";
  ac.fp = {
    callsign: cs,
    aircraft: type,
    flightRules: vfr ? "VFR" : "IFR",
    departing: o.apt,
    arriving: o.arr,
    route: o.route,
    flightLevel: o.rfl,
    sid: sidOf(o.apt, o.route),
  };
  ac.arr = o.arr;
  ac.gnd!.climb = stripClimb(ctx, cs) ?? S.defaultClimbFt;
  return ac;
}

/**
 * After-tick pass: departures passing 1000 ft join their route (HDGxxx or fixes, SID expanded for
 * the departure runway), unless the host already turned them, gave a direct or an approach.
 * A strip SID overrides the route's SID; strip SID "VIS" means no SID, fly direct.
 */
export function departureJoin(ac: Aircraft, ctx: SimContext): void {
  const dep = ac.dep;
  if (!dep || dep.joined || dep.overridden || ac.onGround || ac.altitude < S.depJoinRouteAboveFt) return;
  const apt = dep.rwy.split("-")[0]!;
  let route = dep.route;
  const sid = ctx.strips[ac.callsign]?.o_sid;
  if (sid === "VIS") route = "";
  else if (sid) route = [sid, ...routeTokens(route).filter((t) => !isSidToken(apt, t))].join(" ");
  if (route.toUpperCase() === "CCT") {
    dep.joined = true;
    return;
  }
  const ex = expandRoute(route, { dep: apt, arr: ac.arr, runway: dep.rwy });
  // a route that starts behind it: climb straight out to the cleared altitude before turning back
  // over the airport (above the departures climbing out after it)
  const first = ex.heading === null ? ex.points[0] : undefined;
  if (first && Math.abs(angleDiff(ac.heading, bearing(ac.pos, first.pos))) > 90 && ac.altitude < ac.assigned.alt - 50) return;
  dep.joined = true;
  if (ex.unknown.length) ctx.log(`${ac.callsign}: unknown route element(s) ${ex.unknown.join(" ")}`, "warn");
  if (ex.heading !== null) {
    ac.assigned.heading = ex.heading;
    return;
  }
  ac.fixList = ex.points;
  if (ex.sid) ac.fp.sid = ex.sid;
  ac.homing = Boolean(ac.arr && ac.arr !== apt);
}

/** After-tick pass: homing aircraft within arrivalRemoveNm of their destination are logged ARRIVED and removed. */
export function arrivalCheck(ac: Aircraft, ctx: SimContext): void {
  if (!ac.homing || !ac.arr || ac.onGround || ac.fixList.length || ac.approach || ac.cct || ac.hold) return;
  const ref = airportRef(ac.arr);
  if (ref && dist(ac.pos, ref) <= S.arrivalRemoveNm * S.unitsPerNm) {
    ctx.log(`ARRIVED ${ac.callsign} ${ac.arr}`);
    ctx.counters.arrived++;
    ac.gone = true;
  }
}
