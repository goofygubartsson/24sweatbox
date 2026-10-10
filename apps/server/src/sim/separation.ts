// Automatic separation. Aircraft flying on their own after a ground departure (Aircraft.autoFlight,
// until a controller instructs them) keep sim.sepLossNm / sim.sepLossFt from every other airborne
// aircraft. Every few seconds each one looks ahead along its route: if its planned climb, descent
// or path would take it inside the minimum, it levels off below (or climbs above) the traffic and,
// behind traffic on the same track, slows down. The limits lift once the plan is clear again.
import { config } from "@sweatbox/config";
import {
  add,
  angleDiff,
  appr,
  bearing,
  DEG,
  dist,
  dot,
  expandRoute,
  findRunwayEnd,
  fromAviationAngle,
  isGaType,
  rwyEnd,
  samePair,
  scale,
  sub,
  type Vec,
} from "@sweatbox/shared";
import type { Aircraft, SepLimit } from "./types";
import type { SimContext } from "./context";

const S = config.sim;
const A = S.autoSep;
const U = S.unitsPerNm;

/** The route's first point is behind: departures climb to their cleared altitude before turning back. */
export const turnsBack = (heading: number, from: Vec, first: Vec): boolean => Math.abs(angleDiff(heading, bearing(from, first))) > 90;

/** Flying on its own (and keeping separation by itself). */
export const isAuto = (ac: Aircraft): boolean => ac.autoFlight !== null && !ac.onGround && !ac.gone;

/** Established on a final: it keeps its glidepath (it can only slow down). */
const onFinal = (ac: Aircraft): boolean => ac.approach !== null && ac.apprCaptured;

/** The approach it is on, or (flying on its own) the final it is heading for. */
const approachOf = (ac: Aircraft): string | null =>
  ac.approach ?? (ac.autoLand?.rwy && ac.fixList.length === 1 && ac.fixList[0]!.name === ac.autoLand.rwy ? ac.autoLand.rwy : null);

/** Both on (or joining) approaches to two parallel runways of one airport (independent parallel approaches). */
export function parallelApproaches(a: Aircraft, b: Aircraft): boolean {
  const ra = approachOf(a);
  const rb = approachOf(b);
  if (!ra || !rb || ra === rb) return false;
  const ea = findRunwayEnd(ra);
  const eb = findRunwayEnd(rb);
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

/** Pairs that don't need the separation minimum (and aren't reported as losses). */
export const separationExempt = (a: Aircraft, b: Aircraft): boolean =>
  parallelApproaches(a, b) || parallelRunwayOps(a, b) || sameCircuit(a, b);

/** Two aircraft in the circuit of one airport: the tower separates them visually. */
const sameCircuit = (a: Aircraft, b: Aircraft): boolean => Boolean(a.cct && b.cct && a.cct.rwy.split("-")[0] === b.cct.rwy.split("-")[0]);

/** Where an aircraft is going: along its route (or approach), at its speed, toward its altitude. */
interface Track {
  pts: Vec[];
  /** Map units per second. */
  speed: number;
  alt: number;
  /** Altitude it is climbing / descending to, and how fast (ft/s, signed). */
  target: number;
  rate: number;
  /** Stays at the last point once there (holding)... */
  stop?: boolean;
  /** ...anywhere within this many NM of it (the racetrack). */
  radiusNm?: number;
  /** Altitude profile instead of target / rate (on a final). */
  altFn?: (sec: number) => number;
}

/** On a final from `pos` at `alt`: down at the descent rate until on the glidepath, then along it. */
function finalProfile(pos: Vec, threshold: Vec, speed: number, alt: number): (sec: number) => number {
  const d0 = dist(pos, threshold) / U;
  return (sec) => {
    const glide = Math.max(0, d0 - (speed * sec) / U) * S.ftPerNm * Math.tan(S.glideslopeDeg * DEG);
    return Math.min(alt, Math.max(glide, alt - S.climbFtPerSec * sec));
  };
}

function trackOf(ac: Aircraft, withLimits: boolean): Track {
  const pts: Vec[] = [ac.pos];
  const speed = ac.groundSpeed / 3600;
  let target = ac.assigned.alt;
  if (withLimits && ac.sepLimit) target = Math.min(ac.sepLimit.altMax ?? Infinity, Math.max(ac.sepLimit.altMin ?? -Infinity, target));
  const rate = Math.sign(target - ac.altitude) * S.climbFtPerSec;
  const end = ac.approach && !ac.cct ? findRunwayEnd(ac.approach) : undefined;
  if (end) {
    // down the final to the threshold
    const th = appr(end).threshold;
    pts.push(th);
    return { pts, speed, alt: ac.altitude, target: 0, rate: 0, altFn: finalProfile(ac.pos, th, speed, ac.altitude) };
  }
  if (ac.hold) {
    // somewhere on its racetrack: behind the fix (away along the inbound course), on the turn side
    const h = ac.hold;
    const leg = speed * h.leg;
    const width = (2 * speed) / (S.turnDegPerSec * DEG);
    const centre = add(add(h.pos, fromAviationAngle(h.crs + 180, leg / 2)), fromAviationAngle(h.crs + (h.dir === "R" ? 90 : -90), width / 2));
    pts.push(centre);
    return { pts, speed, alt: ac.altitude, target, rate, stop: true, radiusNm: Math.hypot(leg / 2, width / 2) / U };
  }
  if (!ac.cct) {
    for (const f of ac.fixList) pts.push(f.pos);
    const al = ac.autoLand?.rwy ? findRunwayEnd(ac.autoLand.rwy) : undefined;
    if (al && ac.fixList.length === 1 && ac.fixList[0]!.name === al.name) pts.push(appr(al).threshold); // then down that final
    const dep = ac.dep;
    if (dep && !dep.joined && !dep.overridden && !ac.fixList.length && target >= S.depJoinRouteAboveFt) {
      // straight out until it joins its route (passing depJoinRouteAboveFt, or at its cleared
      // altitude when the route turns back), then along it
      const route = expandRoute(dep.route, { dep: dep.rwy.split("-")[0], arr: ac.arr, runway: dep.rwy });
      const first = route.heading === null ? route.points[0] : undefined;
      const joinAt = first && turnsBack(ac.heading, ac.pos, first.pos) ? target : S.depJoinRouteAboveFt;
      const climbSec = Math.max(0, (joinAt - ac.altitude) / S.climbFtPerSec);
      pts.push(add(ac.pos, fromAviationAngle(ac.heading, Math.max(speed * climbSec, 1e-3))));
      if (route.heading === null) for (const p of route.points) pts.push(p.pos);
    }
  }
  if (pts.length === 1) pts.push(add(ac.pos, fromAviationAngle(ac.heading, 1)));
  return { pts, speed, alt: ac.altitude, target, rate };
}



function posAt(t: Track, sec: number): Vec {
  let left = t.speed * sec;
  for (let i = 1; i < t.pts.length; i++) {
    const d = dist(t.pts[i - 1]!, t.pts[i]!);
    if (t.stop && i === t.pts.length - 1) left = Math.min(left, d);
    if (left <= d || i === t.pts.length - 1) {
      const dir = d > 1e-9 ? scale(sub(t.pts[i]!, t.pts[i - 1]!), 1 / d) : { x: 0, y: 0 };
      return add(t.pts[i - 1]!, scale(dir, left)); // past the last point: straight on
    }
    left -= d;
  }
  return t.pts[0]!;
}

function altAt(t: Track, sec: number): number {
  if (t.altFn) return t.altFn(sec);
  const a = t.alt + t.rate * sec;
  return t.rate >= 0 ? Math.min(a, Math.max(t.alt, t.target)) : Math.max(a, Math.min(t.alt, t.target));
}

/**
 * Seconds until the two tracks come inside the minimum (plus the buffer) within `horizon`, or null.
 * `b` is `bAhead` seconds further on.
 */
function conflictIn(a: Track, b: Track, bAhead = 0, horizon: number = A.lookaheadSec): number | null {
  const near = S.sepLossNm + A.bufferNm + (a.radiusNm ?? 0) + (b.radiusNm ?? 0);
  for (let sec = 0; sec <= horizon; sec += A.stepSec) {
    const nm = dist(posAt(a, sec), posAt(b, sec + bAhead)) / U;
    const ft = Math.abs(altAt(a, sec) - altAt(b, sec + bAhead));
    if (nm < near && ft < S.sepLossFt + A.bufferFt) return sec;
  }
  return null;
}

/** Which of two conflicting aircraft gives way: anyone not flying on its own has priority, then an
 * aircraft established on final, then the one that departed first. */
function givesWay(a: Aircraft, b: Aircraft): boolean {
  if (!isAuto(b)) return true;
  if (onFinal(a) !== onFinal(b)) return !onFinal(a);
  return a.autoFlight! > b.autoFlight! || (a.autoFlight === b.autoFlight && a.callsign > b.callsign);
}

/** Pairs the automatic separation leaves alone: the ground, landings, parallel approaches, and
 * circuit traffic (the tower separates that visually). */
const exempt = (a: Aircraft, b: Aircraft) =>
  b === a || b.gone || b.onGround || b.landing !== null || a.landing !== null || b.cct !== null || separationExempt(a, b);

/**
 * First conflict (seconds) of `ac` going to `level` with any of `others`, or null. Traffic it is
 * already too close to counts from when it gets there, if it moves away from that traffic.
 */
function levelConflict(ac: Aircraft, desired: Track, level: number, others: Aircraft[]): number | null {
  const mine: Track = { ...desired, target: level, rate: Math.sign(level - ac.altitude) * S.climbFtPerSec };
  const reach = Math.abs(level - ac.altitude) / S.climbFtPerSec;
  let best: number | null = null;
  for (const o of others) {
    const ot = trackOf(o, true);
    let sec: number | null;
    if (conflictIn(mine, ot, 0, 0) !== null) {
      const side = Math.sign(ac.altitude - o.altitude);
      const away = side === 0 || Math.sign(level - ac.altitude) === side;
      sec = away && reach > 0 ? conflictFrom(mine, ot, reach) : 0;
    } else sec = conflictIn(mine, ot);
    if (sec !== null && (best === null || sec < best)) best = sec;
  }
  return best;
}

/** Like conflictIn, from `from` seconds on. */
function conflictFrom(a: Track, b: Track, from: number): number | null {
  const near = S.sepLossNm + A.bufferNm + (a.radiusNm ?? 0) + (b.radiusNm ?? 0);
  for (let sec = Math.ceil(from / A.stepSec) * A.stepSec; sec <= A.lookaheadSec; sec += A.stepSec) {
    const nm = dist(posAt(a, sec), posAt(b, sec)) / U;
    if (nm < near && Math.abs(altAt(a, sec) - altAt(b, sec)) < S.sepLossFt + A.bufferFt) return sec;
  }
  return null;
}

/**
 * The limits that keep `ac` clear of everyone it has to give way to (null: none needed). Behind
 * traffic on the same track it slows down; otherwise it picks the level nearest its cleared one
 * that is clear of all traffic (else at least of the traffic it gives way to).
 */
function limitsFor(ac: Aircraft, ctx: SimContext): SepLimit | null {
  const desired = trackOf(ac, false); // what it would do without limits
  const others = ctx.aircraft.filter((o) => !exempt(ac, o));
  // those it gives way to, and anyone that can't get clear of it by itself
  const senior = others.filter((o) => givesWay(ac, o) || o.sepLimit?.stuck === true);
  const conflicts = senior.filter((o) => conflictIn(desired, trackOf(o, true)) !== null);
  if (!conflicts.length) return null;
  const lim: SepLimit = {};
  const forward = fromAviationAngle(ac.heading);
  const minSpeed = onFinal(ac) ? S.approachSpeedKt : A.minSpeedKt;
  const levels = new Set<number>([Math.round(ac.altitude)]);
  // 1000 ft (and the buffer) above and below everyone nearby
  for (const o of others)
    if (dist(o.pos, ac.pos) / U < A.levelSearchNm) {
      const ot = trackOf(o, true);
      levels.add(Math.floor((Math.min(o.altitude, ot.target) - S.sepLossFt - A.bufferFt) / 100) * 100);
      levels.add(Math.ceil((Math.max(o.altitude, ot.target) + S.sepLossFt + A.bufferFt) / 100) * 100);
    }
  for (const o of conflicts) {
    const sameFinal = ac.autoLand?.rwy != null && (o.autoLand?.rwy === ac.autoLand.rwy || o.approach === ac.autoLand.rwy);
    const ahead = dot(sub(o.pos, ac.pos), forward) > 0;
    if (!o.hold && ahead && (sameFinal || Math.abs(angleDiff(ac.heading, o.heading)) <= A.inTrailDeg))
      lim.speedMax = Math.min(lim.speedMax ?? Infinity, Math.max(minSpeed, o.groundSpeed - A.slowerKt));
    const ot = trackOf(o, true);
    levels.add(Math.floor((Math.min(o.altitude, ot.target) - S.sepLossFt - A.bufferFt) / 100) * 100);
    levels.add(Math.ceil((Math.max(o.altitude, ot.target) + S.sepLossFt + A.bufferFt) / 100) * 100);
  }
  if (!onFinal(ac)) {
    const want = ac.assigned.alt;
    const here = Math.round(ac.altitude);
    const candidates = [...levels].filter((l) => l <= A.maxAltFt && (l >= A.minAltFt || l >= here));
    const nearest = (list: number[]) => list.sort((p, q) => Math.abs(p - want) - Math.abs(q - want) || Math.abs(p - here) - Math.abs(q - here))[0];
    let level = nearest(candidates.filter((l) => levelConflict(ac, desired, l, others) === null));
    level ??= nearest(candidates.filter((l) => levelConflict(ac, desired, l, senior) === null));
    // nothing clear: the level that stays clear longest, and the others are asked to help
    if (level === undefined) {
      level = candidates.sort((p, q) => (levelConflict(ac, desired, q, senior) ?? Infinity) - (levelConflict(ac, desired, p, senior) ?? Infinity))[0];
      lim.stuck = true;
    }
    if (level !== undefined && level !== want) {
      if (level < want) lim.altMax = level;
      else lim.altMin = level;
    }
  }
  return Object.keys(lim).length ? lim : null;
}

/** Tick step: refresh the limits of every aircraft flying on its own (every autoSep.checkEverySec). */
export function autoSeparation(ctx: SimContext): void {
  if (ctx.simTotal % A.checkEverySec !== 0) return;
  for (const ac of ctx.aircraft) {
    if (!isAuto(ac)) {
      if (ac.autoFlight === null) ac.sepLimit = null;
      continue;
    }
    ac.sepLimit = limitsFor(ac, ctx);
  }
}

/**
 * A departure about to roll on `rwy`: where it will be from lift-off on (straight out until it joins
 * its route, then along the route, climbing to its initial climb), and how long the roll takes.
 */
function departureTrack(ac: Aircraft, rwy: string): { track: Track; rollSec: number } | null {
  const end = findRunwayEnd(rwy);
  if (!end) return null;
  const g = rwyEnd(end);
  const G = config.ground;
  const vr = Math.min(isGaType(ac.type) ? config.circuit.gaRotateKt : G.rotateKt, G.maxTakeoffKt);
  const rollSec = vr / G.takeoffAccelKtPerSec;
  const rollUnits = (vr * vr) / (2 * G.takeoffAccelKtPerSec) / 3600;
  const along = Math.max(0, Math.min(g.length, dot(sub(ac.pos, g.start), g.dir)));
  const lift = add(g.start, scale(g.dir, Math.min(g.length, along + rollUnits)));
  const speed = (S.defaultDepSpeedKt * 0.9) / 3600;
  const climb = ac.gnd?.climb ?? S.defaultClimbFt;
  const route = expandRoute(ac.fp.route, { dep: end.icao, arr: ac.fp.arriving, runway: rwy });
  const first = route.heading === null ? route.points[0] : undefined;
  const joinAt = first && turnsBack(g.heading, lift, first.pos) ? climb : S.depJoinRouteAboveFt;
  const joinSec = Math.max(0, (joinAt - S.depInitialAltFt) / S.climbFtPerSec);
  const pts = [lift, add(lift, scale(g.dir, speed * joinSec))];
  if (route.heading === null && route.points.length) for (const p of route.points) pts.push(p.pos);
  else pts.push(add(pts[1]!, fromAviationAngle(route.heading ?? g.heading, 1)));
  return { track: { pts, speed, alt: S.depInitialAltFt, target: climb, rate: S.climbFtPerSec }, rollSec };
}

/**
 * Takeoff release: traffic the departure would come inside the minimum of during its climb-out if
 * it rolled now (or null). Circuit traffic is the tower's (visual) business, and traffic landing
 * at this airport the runway checks'.
 */
export function releaseConflict(ac: Aircraft, ctx: SimContext, rwy: string): Aircraft | null {
  const dep = departureTrack(ac, rwy);
  if (!dep) return null;
  const apt = rwy.split("-")[0]!;
  for (const o of ctx.aircraft) {
    if (o === ac || o.gone || o.onGround || o.landing || o.cct) continue;
    if (o.approach && findRunwayEnd(o.approach)?.icao === apt) continue;
    if (conflictIn({ ...dep.track, radiusNm: A.releaseBufferNm }, trackOf(o, true), dep.rollSec) !== null) return o;
  }
  return null;
}

/**
 * Joining a final: traffic the aircraft would come inside the minimum of on its way down the final
 * from here to the runway (or null). Approaches to a parallel runway don't count.
 */
export function approachConflict(ac: Aircraft, ctx: SimContext, rwy: string, finalPoint: Vec = ac.pos): Aircraft | null {
  const end = findRunwayEnd(rwy);
  if (!end) return null;
  const speed = ac.groundSpeed / 3600;
  const th = appr(end).threshold;
  // level to the final point (from a hold beside it), then down the final; with the release margin
  // (turns onto routes and finals aren't modelled)
  const toPoint = dist(ac.pos, finalPoint) / Math.max(speed, 1e-6);
  const down = finalProfile(finalPoint, th, speed, ac.altitude);
  const altFn = (sec: number) => (sec < toPoint ? ac.altitude : down(sec - toPoint));
  const mine: Track = { pts: [ac.pos, finalPoint, th], speed, alt: ac.altitude, target: 0, rate: 0, altFn, radiusNm: A.releaseBufferNm };
  const probe = { ...ac, approach: rwy } as Aircraft;
  const horizon = Math.max(A.lookaheadSec, toPoint + Math.min(A.finalLookaheadSec, dist(finalPoint, th) / Math.max(speed, 1e-6)));
  for (const o of ctx.aircraft) {
    if (exempt(ac, o) || parallelApproaches(probe, o)) continue;
    // someone on its own still on its way to a final, who gives way to us: it waits, not us
    if (isAuto(o) && !onFinal(o) && isAuto(ac) && givesWay(o, ac)) continue;
    if (conflictIn(mine, trackOf(o, true), 0, horizon) !== null) return o;
  }
  return null;
}
