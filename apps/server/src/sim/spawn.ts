// Creating aircraft (SPAWN / DEP / GATE) and the departure route join (spec 5.5).
import crypto from "node:crypto";
import { config } from "@sweatbox/config";
import {
  add,
  airportRef,
  alongTrackNm,
  angleDiff,
  appr,
  dot,
  fromAviationAngle,
  samePair,
  sub,
  aviationAngle,
  bearing,
  dist,
  expandRoute,
  findRunwayEnd,
  isSidToken,
  routeHeading,
  routeTokens,
  runwayEndNames,
  rwyEnd,
  scale,
  wakeOf,
  type Vec,
} from "@sweatbox/shared";
import type { Aircraft } from "./types";
import type { SimContext } from "./context";
import { parkAtStand, stripClimb } from "./ground";
import { glideAltitude } from "./air";
import { approachConflict, turnsBack } from "./separation";

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
    autoLand: null,
    autoFlight: null,
    sepLimit: null,
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
  const cleared = Math.min(ac.assigned.alt, ac.sepLimit?.altMax ?? Infinity);
  if (first && turnsBack(ac.heading, ac.pos, first.pos) && ac.altitude < cleared - 50) return;
  dep.joined = true;
  if (ex.unknown.length) ctx.log(`${ac.callsign}: unknown route element(s) ${ex.unknown.join(" ")}`, "warn");
  if (ex.heading !== null) {
    ac.assigned.heading = ex.heading;
    return;
  }
  ac.fixList = ex.points;
  if (ex.sid) ac.fp.sid = ex.sid;
  ac.homing = Boolean(ac.arr && ac.arr !== apt);
  // to another airport with runways: land there at the end of the route
  ac.autoLand = ac.homing && runwayEndNames(ac.arr!).length ? { rwy: null } : null;
}

const finalPoint = (rwy: string): Vec => {
  const a = appr(findRunwayEnd(rwy)!);
  return add(a.threshold, scale(a.out, S.autoLandFinalNm * S.unitsPerNm));
};

/**
 * The destination runway end whose final is easiest to join from here: little turn, not far, not
 * busy. At the session's airport only its arrival runways ([sweatbox] arrival runways); elsewhere
 * the one already in use, if any.
 */
function finalFor(apt: string, pos: Vec, ctx: SimContext): string | null {
  const cfg = ctx.runwayConfig;
  const here = cfg && cfg.apt === apt && cfg.arr.length ? cfg.arr.map((d) => `${apt}-${d}`).filter((n) => findRunwayEnd(n)) : [];
  const busy = (name: string) => ctx.aircraft.filter((o) => !o.gone && !o.onGround && (o.approach === name || o.autoLand?.rwy === name)).length;
  // elsewhere: the runway already in use there, so nobody lands on a crossing runway at the same time
  if (!here.length) {
    const inUse = runwayEndNames(apt)
      .map((name) => ({ name, n: busy(name) }))
      .filter((r) => r.n > 0)
      .sort((p, q) => q.n - p.n)[0];
    if (inUse) return inUse.name;
  }
  let best: string | null = null;
  let bestScore = Infinity;
  for (const name of here.length ? here : runwayEndNames(apt)) {
    const p = finalPoint(name);
    const turn = Math.abs(angleDiff(bearing(pos, p), appr(findRunwayEnd(name)!).course));
    // 1 NM further = 3 degrees less turn; each aircraft already on (or heading for) it = 15 degrees
    const score = turn + (dist(pos, p) / S.unitsPerNm) * 3 + busy(name) * 15;
    if (score < bestScore) [best, bestScore] = [name, score];
  }
  return best;
}

/**
 * Not yet: someone on this final less than autoLandGapNm past its final point, or traffic it would
 * come inside the separation minimum of on the way down.
 */
function finalBusy(ac: Aircraft, ctx: SimContext, rwy: string): boolean {
  const a = appr(findRunwayEnd(rwy)!);
  const close = ctx.aircraft.some(
    (o) => o !== ac && !o.gone && !o.onGround && !o.landing && o.approach === rwy && alongTrackNm(a, o.pos) > S.autoLandFinalNm - S.autoLandGapNm,
  );
  return close || approachConflict(ac, ctx, rwy, finalPoint(rwy)) !== null;
}

/**
 * Hold beside the final point until the final is clear: autoLandHoldOffsetNm to the side away from
 * the airport's other runways (the session's other arrival runways at its own airport), inbound
 * along the final course, turning away from the final.
 */
function holdAtFinal(ac: Aircraft, ctx: SimContext, rwy: string): void {
  const end = findRunwayEnd(rwy)!;
  const a = appr(end);
  const crs = Math.round(a.course) || 360;
  const right = fromAviationAngle(crs + 90);
  const cfg = ctx.runwayConfig;
  const others = (cfg && cfg.apt === end.icao && cfg.arr.length > 1 ? cfg.arr.map((d) => `${end.icao}-${d}`) : runwayEndNames(end.icao))
    .map((n) => findRunwayEnd(n))
    .filter((e): e is NonNullable<typeof e> => Boolean(e) && e!.name !== end.name && !samePair(e!.pair.pair, end.pair.pair));
  const offset = others.reduce((sum, e) => sum + dot(sub(appr(e).threshold, a.threshold), right), 0);
  const dir = offset > 0 ? "L" : "R"; // the others on the right: hold on the left
  const side = fromAviationAngle(crs + (dir === "R" ? 90 : -90), S.autoLandHoldOffsetNm * S.unitsPerNm);
  ac.fixList = [];
  ac.hold = { fix: rwy, pos: add(finalPoint(rwy), side), crs, dir, leg: S.hold.defaultLegSec, ph: "entry", turnTo: (crs + 180) % 360, next: "out", t: 0, resume: [] };
}

/**
 * End of an auto-landing departure's route: fly to a point on a final at the destination, then
 * the approach from there (landing.ts removes it on touchdown); hold there while the aircraft ahead
 * is still close. False when there is no runway.
 */
function joinFinal(ac: Aircraft, ctx: SimContext): boolean {
  const al = ac.autoLand!;
  if (al.rwy && dist(ac.pos, finalPoint(al.rwy)) <= 2 * S.fixPassNm * S.unitsPerNm) {
    if (finalBusy(ac, ctx, al.rwy)) holdAtFinal(ac, ctx, al.rwy);
    else {
      ac.approach = al.rwy;
      ac.apprCaptured = false;
    }
    return true;
  }
  al.rwy = finalFor(ac.arr!, ac.pos, ctx);
  if (!al.rwy) return false;
  ac.fixList = [{ name: al.rwy, pos: finalPoint(al.rwy) }];
  ac.assigned.alt = Math.min(ac.assigned.alt, Math.round(glideAltitude(S.autoLandFinalNm) / 100) * 100);
  ac.assigned.speed = Math.min(ac.assigned.speed, S.autoLandSpeedKt);
  return true;
}

/**
 * After-tick pass at the end of a homing aircraft's route: departures to another airport join a
 * final there; the others are logged ARRIVED and removed within arrivalRemoveNm of the destination.
 */
export function arrivalCheck(ac: Aircraft, ctx: SimContext): void {
  const al = ac.autoLand;
  if (ac.homing && al?.rwy && ac.hold?.fix === al.rwy) {
    // holding at its final point: once the final is clear, back to the point and onto the approach
    if (!finalBusy(ac, ctx, al.rwy)) {
      ac.hold = null;
      ac.fixList = [{ name: al.rwy, pos: finalPoint(al.rwy) }];
    }
    return;
  }
  if (!ac.homing || !ac.arr || ac.onGround || ac.fixList.length || ac.approach || ac.cct || ac.hold) return;
  if (al && joinFinal(ac, ctx)) return;
  const ref = airportRef(ac.arr);
  if (ref && dist(ac.pos, ref) <= S.arrivalRemoveNm * S.unitsPerNm) {
    ctx.log(`ARRIVED ${ac.callsign} ${ac.arr}`);
    ctx.counters.arrived++;
    ac.gone = true;
  }
}
