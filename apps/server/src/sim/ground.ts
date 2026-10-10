// Ground movement (spec 6). State machine per aircraft (gnd.mode):
//   stand -> push -> (taxi | follow | holding) -> lineup -> lined -> takeoff -> airborne
//   arrivals: rollout -> holding -> taxi -> stand
import { config } from "@sweatbox/config";
import {
  add,
  angleDiff,
  appr,
  aviationAngle,
  bearing,
  crossingStops,
  dist,
  dot,
  edgeDirFrom,
  edgePointsFrom,
  entriesForRunway,
  entryNearHold,
  findRunwayEnd,
  getGroundGraph,
  heading3,
  holdShortNodes,
  holdsForRunway,
  isGaType,
  len,
  lengthUnits,
  nearestNode,
  neg,
  nodeTaxiways,
  normalize,
  pairHasDesignator,
  perp,
  polylineLength,
  projectOnPolyline,
  pushFacingOptions,
  routeVia,
  rwyEnd,
  samePair,
  scale,
  shortestPath,
  standLeadIn,
  sub,
  type GPath,
  type GroundGraph,
  type GStand,
  type Vec,
} from "@sweatbox/shared";
import type { Aircraft, AutoState, GroundState, PathPoint, TaxiRequest, TaxiTarget } from "./types";
import { releaseConflict } from "./separation";
import type { SimContext } from "./context";
import { makeCircuit } from "./circuit";
import { reject } from "../errors";

const G = config.ground;
const S = config.sim;

const RUNWAY_DESIGNATOR = /^\d{2}[LCR]?$/;

export function graphOf(ac: Aircraft): GroundGraph {
  const g = ac.gnd ? getGroundGraph(ac.gnd.apt) : undefined;
  if (!g) throw reject("Aircraft is not on the ground");
  return g;
}

export function newGroundState(apt: string, partial: Partial<GroundState> = {}): GroundState {
  return {
    apt,
    mode: "holding",
    status: "HOLDING",
    statusBeforeStop: null,
    stand: null,
    path: [],
    node: null,
    noUturnEdge: null,
    reverse: false,
    endHeading: null,
    queued: null,
    pushFacing: [],
    target: null,
    rwy: null,
    climb: S.defaultClimbFt,
    wait: false,
    spacing: false,
    paused: false,
    follow: null,
    parkedSince: null,
    arrival: false,
    rolloutExitAt: null,
    crossStops: [],
    auto: null,
    ...partial,
  };
}

const nodeName = (g: GroundGraph, n: number) => `${n} (${nodeTaxiways(g, n).join("/") || "?"})`;

/** Polyline of a graph path as path points (first node included), tagging graph nodes. */
function toPathPoints(g: GroundGraph, path: GPath): PathPoint[] {
  const out: PathPoint[] = [{ p: g.nodes[path.nodes[0]!]!, n: path.nodes[0]! }];
  path.edges.forEach((eid, i) => {
    const pts = edgePointsFrom(g.edges[eid]!, path.nodes[i]!);
    pts.slice(1).forEach((p, k) => out.push({ p, n: k === pts.length - 2 ? path.nodes[i + 1]! : null }));
  });
  return out;
}

/** Drop the last `d` units of a path (stop short of an intersection). */
function trimEnd(points: PathPoint[], d: number): PathPoint[] {
  const out = [...points];
  let left = d;
  while (out.length >= 2 && left > 0) {
    const a = out[out.length - 2]!.p;
    const b = out[out.length - 1]!.p;
    const seg = dist(a, b);
    if (seg <= left) {
      out.pop();
      left -= seg;
    } else {
      out[out.length - 1] = { p: add(b, scale(normalize(sub(a, b)), left)), n: null };
      left = 0;
    }
  }
  return out;
}

/**
 * Fly the corners of a path as curves: a corner sharper than turnMinDeg becomes a quadratic curve
 * from `radius` before it to `radius` after it (less on short legs). A graph node on a corner moves
 * to the middle of its curve, so stops and runway crossings still trigger there. `from` is where
 * the aircraft is (the path starts after it).
 */
export function smoothCorners(from: Vec, points: PathPoint[], radius: number): PathPoint[] {
  if (points.length < 2 || radius <= 0) return points;
  const out: PathPoint[] = [];
  let prev = from;
  points.forEach((cur, i) => {
    const next = points[i + 1];
    const din = sub(cur.p, prev);
    const dout = next ? sub(next.p, cur.p) : null;
    const lin = len(din);
    const lout = dout ? len(dout) : 0;
    const turn = dout && lin > 1e-9 && lout > 1e-9 ? Math.abs(angleDiff(aviationAngle(din), aviationAngle(dout))) : 0;
    prev = cur.p;
    // the end point stays exact; reversals can't be rounded
    if (!dout || turn < G.turnMinDeg || turn > 150) {
      out.push(cur);
      return;
    }
    const r = Math.min(radius, lin * 0.45, lout * 0.45);
    const a = sub(cur.p, scale(din, r / lin));
    const b = add(cur.p, scale(dout, r / lout));
    const steps = Math.max(3, Math.ceil(turn / 15));
    const middle = Math.round(steps / 2);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      const p = { x: u * u * a.x + 2 * u * t * cur.p.x + t * t * b.x, y: u * u * a.y + 2 * u * t * cur.p.y + t * t * b.y };
      out.push({ p, n: k === middle ? cur.n : null });
    }
  });
  return out;
}

function standFree(ctx: SimContext, ac: Aircraft, apt: string, name: string): boolean {
  return !ctx.aircraft.some((o) => o !== ac && !o.gone && o.gnd?.apt === apt && o.gnd.stand === name);
}

// ---- spawning ------------------------------------------------------------------------------------------

/** GATE / STAND: park nose-in on a stand. Returns false (with a log line) when impossible. */
export function parkAtStand(ac: Aircraft, apt: string, standName: string, ctx: SimContext): boolean {
  const g = getGroundGraph(apt);
  if (!g) {
    ctx.log(`${ac.callsign}: ${apt} has no ground map, cannot park on stand ${standName}`, "warn");
    return false;
  }
  const stand = g.standByName.get(standName.toUpperCase());
  if (!stand) {
    ctx.log(`${ac.callsign}: unknown stand ${apt}-${standName}`, "warn");
    return false;
  }
  if (!standFree(ctx, ac, g.icao, stand.name)) ctx.log(`${ac.callsign}: stand ${apt}-${stand.name} is already occupied`, "warn");
  ac.pos = { ...g.nodes[stand.n]! };
  ac.heading = stand.hdg % 360;
  ac.onGround = true;
  ac.altitude = 0;
  ac.groundSpeed = 0;
  ac.assigned = { alt: 0, heading: Math.round(stand.hdg) || 360, speed: 0 };
  ac.gnd = newGroundState(g.icao, {
    mode: "stand",
    status: `ON STAND ${stand.name}`,
    stand: stand.name,
    node: stand.n,
    pushFacing: pushFacingOptions(g, stand),
  });
  return true;
}

// ---- movement --------------------------------------------------------------------------------------------

/** Highest speed from which we can still slow to vEnd within d map units at `decel` kt/s. */
const vAllowed = (vEnd: number, decel: number, d: number) => Math.sqrt(vEnd * vEnd + 2 * decel * 3600 * Math.max(0, d));

/** The aircraft's position and its path ahead, up to `maxDist`. */
function pathAhead(ac: Aircraft, maxDist: number): Vec[] {
  const pts: Vec[] = [ac.pos];
  let acc = 0;
  for (const pp of ac.gnd?.path ?? []) {
    acc += dist(pts[pts.length - 1]!, pp.p);
    pts.push(pp.p);
    if (acc > maxDist) break;
  }
  return pts;
}

/**
 * Free distance ahead before we must stop for traffic (null = nothing ahead).
 *  - traffic on our path ahead: stop a length behind it. If it also has us on its own path ahead
 *    (an intersection), whoever is further into it goes first and the other gives way;
 *  - traffic whose path crosses ours ahead: whoever gets to the crossing first goes, the other
 *    waits short of it;
 *  - an aircraft being pushed back sweeps its whole push path and can't give way: keep clear of it;
 *  - head-on traffic stops both.
 */
function spacingGap(ac: Aircraft, ctx: SimContext): number | null {
  const gnd = ac.gnd!;
  const pts = pathAhead(ac, G.spacingLookaheadUnits);
  if (pts.length < 2) return null;
  // look on past the end of the path (a holding point): a shorter aircraft already holding there
  // sits just beyond our stop point
  const last = pts[pts.length - 1]!;
  const dir = normalize(sub(last, pts[pts.length - 2]!));
  pts.push(add(last, scale(dir, G.spacingLookaheadUnits / 2)));
  const myLen = lengthUnits(ac.type);
  let best: number | null = null;
  const keep = (gap: number) => {
    if (best === null || gap < best) best = gap;
  };
  for (const o of ctx.aircraft) {
    if (o === ac || o.gone || !o.onGround || !o.gnd || o.gnd.apt !== gnd.apt) continue;
    if (o.gnd.mode === "stand" && o.gnd.stand !== (gnd.target?.kind === "stand" ? gnd.target.name : null)) continue;
    const clear = myLen / 2 + myLen + lengthUnits(o.type) / 2;
    if (o.gnd.reverse && o.gnd.path.length) {
      const reach = G.spacingLateralUnits + lengthUnits(o.type) / 2;
      for (const q of [o.pos, ...o.gnd.path.map((pp) => pp.p)]) {
        const pr = projectOnPolyline(q, pts);
        if (pr.lateral <= reach && pr.along > 0.002) keep(pr.along - clear);
      }
      continue;
    }
    const headOn = Math.abs(angleDiff(ac.heading, o.heading)) > 135;
    const proj = projectOnPolyline(o.pos, pts);
    if (proj.lateral <= G.spacingLateralUnits && proj.along > 0.002) {
      if (!headOn && o.gnd.path.length) {
        const mine = projectOnPolyline(ac.pos, pathAhead(o, G.spacingLookaheadUnits));
        const mutual = mine.lateral <= G.spacingLateralUnits && mine.along > 0.002;
        // we are the one further into the crossing: carry on, the other aircraft waits for us
        if (mutual && (proj.lateral > mine.lateral || (proj.lateral === mine.lateral && ac.id < o.id))) continue;
      }
      keep(proj.along - clear);
      continue;
    }
    // not on our path yet: does its path cross ours ahead, and who is there first?
    if (headOn || !o.gnd.path.length || o.groundSpeed < 0.5) continue;
    const theirs = pathAhead(o, G.spacingLookaheadUnits);
    let theirDist = 0;
    for (let i = 1; i < theirs.length; i++) {
      theirDist += dist(theirs[i - 1]!, theirs[i]!);
      const pr = projectOnPolyline(theirs[i]!, pts);
      if (pr.lateral > G.spacingLateralUnits || pr.along <= 0.002) continue;
      if (theirDist < pr.along || (theirDist === pr.along && o.id < ac.id)) keep(pr.along - clear);
      break;
    }
  }
  return best;
}

/** No traffic on our path for the next `d` units (room to cross a runway and clear it). */
function roomAhead(ac: Aircraft, ctx: SimContext, d: number): boolean {
  const pts = pathAhead(ac, d);
  return !ctx.aircraft.some(
    (o) =>
      o !== ac &&
      !o.gone &&
      o.onGround &&
      o.gnd?.apt === ac.gnd!.apt &&
      o.gnd.mode !== "stand" &&
      projectOnPolyline(o.pos, pts).lateral <= G.spacingLateralUnits &&
      projectOnPolyline(o.pos, pts).along > 0.002,
  );
}

function remainingLength(ac: Aircraft): number {
  let acc = 0;
  let prev = ac.pos;
  for (const pp of ac.gnd!.path) {
    acc += dist(prev, pp.p);
    prev = pp.p;
  }
  return acc;
}

/** Speed limit for the next sharp turn ahead: the heading change over turnWindowUnits counts. */
function cornerLimit(ac: Aircraft, cornerKt: number, decel: number): number {
  const legs: { at: number; end: number; hdg: number }[] = [];
  let acc = 0;
  let prev = ac.pos;
  for (const pp of ac.gnd!.path) {
    const d = dist(prev, pp.p);
    if (d > 1e-6) legs.push({ at: acc, end: acc + d, hdg: bearing(prev, pp.p) });
    acc += d;
    prev = pp.p;
    if (acc > 0.35) break;
  }
  let limit = Infinity;
  for (let i = 0; i < legs.length - 1; i++) {
    let j = i + 1;
    while (j + 1 < legs.length && legs[j + 1]!.at - legs[i]!.end <= G.turnWindowUnits) j++;
    if (Math.abs(angleDiff(legs[i]!.hdg, legs[j]!.hdg)) > G.sharpTurnDeg) limit = Math.min(limit, vAllowed(cornerKt, decel, legs[i]!.end));
  }
  return limit;
}

/** Distance along the remaining path to a graph node on it (null when it isn't on the path). */
function distanceToNode(ac: Aircraft, node: number | undefined): number | null {
  if (node === undefined) return null;
  let acc = 0;
  let prev = ac.pos;
  for (const pp of ac.gnd!.path) {
    acc += dist(prev, pp.p);
    if (pp.n === node) return acc;
    prev = pp.p;
  }
  return null;
}

/** How far short of a hold bar's node the aircraft stops: its nose stays behind the red line. */
export const holdBack = (ac: Aircraft): number => lengthUnits(ac.type) / 2 + G.holdLineMarginUnits;

/** A runway to cross ahead: stop short of its hold bar until the controller clears it (CONT). */
function holdShortForCrossing(ac: Aircraft): void {
  const gnd = ac.gnd!;
  const stop = gnd.crossStops.shift()!;
  ac.groundSpeed = 0;
  gnd.paused = true;
  gnd.statusBeforeStop = gnd.status;
  gnd.status = `HOLD SHORT ${stop.rwy}`;
}

/** Move `step` map units along the path, but no further than `stopIn` (the crossing stop point). */
function advance(ac: Aircraft, step: number, stopIn: number | null): void {
  const gnd = ac.gnd!;
  let left = stopIn === null ? step : Math.min(step, stopIn);
  const stopping = stopIn !== null && stopIn - step <= 1e-6;
  while (left > 1e-9 && gnd.path.length) {
    const target = gnd.path[0]!;
    const d = dist(ac.pos, target.p);
    if (d > 1e-9) ac.heading = (bearing(ac.pos, target.p) + (gnd.reverse ? 180 : 0)) % 360;
    if (d <= left) {
      ac.pos = { ...target.p };
      left -= d;
      if (target.n !== null) gnd.node = target.n;
      gnd.path.shift();
    } else {
      ac.pos = add(ac.pos, scale(normalize(sub(target.p, ac.pos)), left));
      left = 0;
    }
  }
  if (stopping) holdShortForCrossing(ac);
}

function moveAlongPath(ac: Aircraft, ctx: SimContext): void {
  const gnd = ac.gnd!;
  if (!gnd.path.length) {
    arrive(ac, ctx);
    return;
  }
  const remaining = remainingLength(ac);
  let allowed: number;
  const onRunwayRollout = gnd.mode === "rollout" && gnd.rolloutExitAt !== null && remaining > gnd.rolloutExitAt;
  if (onRunwayRollout) {
    // decelerate on the runway down to the exit speed, then turn off
    allowed = Math.max(G.rolloutExitKt, ac.groundSpeed - G.rolloutDecelKtPerSec);
    allowed = Math.min(allowed, vAllowed(G.rolloutExitKt, G.rolloutDecelKtPerSec, remaining - gnd.rolloutExitAt!));
  } else {
    allowed = gnd.reverse ? G.pushSpeedKt : gnd.mode === "lineup" ? G.lineupSpeedKt : G.taxiSpeedKt;
    allowed = Math.min(allowed, cornerLimit(ac, G.sharpTurnKt, G.decelStopKtPerSec));
  }
  allowed = Math.min(allowed, vAllowed(G.lastPointKt, G.decelStopKtPerSec, remaining));
  // a runway crossing ahead: stop with the nose short of its hold bar
  const toStopNode = distanceToNode(ac, gnd.crossStops[0]?.node);
  const stopAt = toStopNode === null ? null : Math.max(0, toStopNode - holdBack(ac));
  if (stopAt !== null && stopAt <= 1e-6 && !gnd.paused) {
    holdShortForCrossing(ac);
    return;
  }
  if (stopAt !== null) allowed = Math.min(allowed, vAllowed(G.lastPointKt, G.decelStopKtPerSec, stopAt));
  gnd.spacing = false;
  if (!gnd.reverse && !onRunwayRollout) {
    const gap = spacingGap(ac, ctx);
    if (gap !== null) {
      const v = gap <= 0 ? 0 : vAllowed(0, G.decelHoldKtPerSec, gap);
      if (v < allowed) {
        allowed = v;
        gnd.spacing = true;
      }
    }
  }
  if (gnd.paused) allowed = 0;
  const decel = onRunwayRollout ? G.rolloutDecelKtPerSec : G.decelHoldKtPerSec;
  ac.groundSpeed = ac.groundSpeed < allowed ? Math.min(allowed, ac.groundSpeed + G.accelKtPerSec) : Math.max(allowed, ac.groundSpeed - decel);
  // creep the last metres instead of stalling just short of the end point
  if (ac.groundSpeed < 0.5 && !gnd.paused && !gnd.spacing && remaining < 0.003) ac.groundSpeed = G.lastPointKt;
  if (ac.groundSpeed > 0) advance(ac, ac.groundSpeed / 3600, stopAt);
  if (!gnd.path.length) arrive(ac, ctx);
}

function targetText(g: GroundGraph, t: TaxiTarget | null, route: string[]): string {
  if (!t) return "";
  switch (t.kind) {
    case "hold": {
      const h = g.holds.find((x) => x.name === t.name);
      return h ? `HOLD SHORT ${h.rwy}` : `HOLD ${t.name}`;
    }
    case "stand":
      return `STAND ${t.name}`;
    case "short":
      return `HOLD SHORT ${t.twy}`;
    case "node":
      return `POINT ${t.n}`;
    case "end":
      return `END OF ${route[route.length - 1] ?? "ROUTE"}`;
  }
}

/** End of the current path. */
function arrive(ac: Aircraft, ctx: SimContext): void {
  const gnd = ac.gnd!;
  const g = getGroundGraph(gnd.apt)!;
  ac.groundSpeed = 0;
  if (gnd.endHeading !== null) ac.heading = gnd.endHeading % 360;
  gnd.reverse = false;
  gnd.endHeading = null;
  gnd.spacing = false;
  switch (gnd.mode) {
    case "push": {
      gnd.mode = "holding";
      gnd.status = `PUSHED BACK, FACING ${heading3(ac.heading)}`;
      if (gnd.queued) {
        const q = gnd.queued;
        gnd.queued = null;
        try {
          startTaxi(ac, ctx, q);
        } catch (e) {
          ctx.log(`${ac.callsign}: queued taxi failed: ${(e as Error).message}`, "warn");
        }
      }
      return;
    }
    case "taxi": {
      const t = gnd.target;
      gnd.target = null;
      if (t?.kind === "stand") {
        const stand = g.standByName.get(t.name);
        if (stand) ac.heading = stand.hdg % 360;
        gnd.mode = "stand";
        gnd.stand = t.name;
        gnd.node = stand?.n ?? gnd.node;
        gnd.status = `ON STAND ${t.name}`;
        gnd.pushFacing = stand ? pushFacingOptions(g, stand) : [];
        if (gnd.arrival) {
          gnd.parkedSince = ctx.simTotal;
          ctx.log(`${ac.callsign} parked on stand ${gnd.apt}-${t.name}`);
        }
        return;
      }
      gnd.mode = "holding";
      if (t?.kind === "hold") {
        const h = g.holds.find((x) => x.name === t.name);
        // stopped just short of the bar: logically at the hold (the next taxi or line-up starts there)
        if (h) gnd.node = h.n;
        gnd.status = h ? `HOLDING SHORT ${h.rwy} AT ${h.twy}` : "HOLDING";
      } else if (t?.kind === "short") gnd.status = `HOLDING SHORT ${t.twy}`;
      else gnd.status = "HOLDING";
      if (t?.kind === "node") gnd.node = t.n; // even when it stopped short of a hold bar there
      return;
    }
    case "follow":
      if (gnd.follow?.until) {
        gnd.mode = "holding";
        gnd.status = `HOLDING (FOLLOWED ${ctx.byId(gnd.follow.leaderId)?.callsign ?? "LEADER"} TO ${gnd.follow.until.slice(2)})`;
        gnd.follow = null;
      }
      return;
    case "lineup": {
      const des = gnd.rwy?.split("-")[1] ?? "";
      if (gnd.wait) {
        gnd.mode = "lined";
        gnd.status = `LINED UP ${des}, WAITING`;
      } else {
        gnd.mode = "takeoff";
        gnd.status = `TAKING OFF ${des}`;
      }
      return;
    }
    case "rollout": {
      gnd.mode = "holding";
      gnd.rolloutExitAt = null;
      const twys = gnd.node !== null ? nodeTaxiways(g, gnd.node).join("/") : "";
      gnd.status = `VACATED ${gnd.rwy?.split("-")[1] ?? ""}${twys ? ` VIA ${twys}` : ""}`;
      if (ctx.rolloutMode === "STAND") taxiToStand(ac, ctx);
      return;
    }
    default:
      return;
  }
}

function takeoffRoll(ac: Aircraft, ctx: SimContext): void {
  const gnd = ac.gnd!;
  const end = gnd.rwy ? findRunwayEnd(gnd.rwy) : undefined;
  if (!end) {
    gnd.mode = "holding";
    gnd.status = "HOLDING";
    return;
  }
  const geo = rwyEnd(end);
  ac.heading = aviationAngle(geo.dir);
  ac.groundSpeed = Math.min(G.maxTakeoffKt, ac.groundSpeed + G.takeoffAccelKtPerSec);
  ac.pos = add(ac.pos, scale(geo.dir, ac.groundSpeed / 3600));
  const vr = isGaType(ac.type) ? config.circuit.gaRotateKt : ac.cctAfterTakeoff ? config.circuit.jetRotateKt : G.rotateKt;
  if (ac.groundSpeed >= Math.min(vr, G.maxTakeoffKt)) liftOff(ac, ctx);
}

function liftOff(ac: Aircraft, ctx: SimContext): void {
  const gnd = ac.gnd!;
  const rwy = gnd.rwy!;
  const geo = rwyEnd(findRunwayEnd(rwy)!);
  ac.onGround = false;
  ac.altitude = S.depInitialAltFt;
  ac.assigned = { alt: gnd.climb, heading: Math.round(geo.heading) || 360, speed: S.defaultDepSpeedKt };
  ctx.lastTakeoff[pairKey(gnd.apt, geo.pair)] = ctx.simTotal;
  ac.gnd = null;
  ctx.log(`DEPARTED ${ac.callsign} ${rwy}`);
  ac.arr = ac.fp.arriving;
  // circuit set on the ground, or a local circuit flight (route CCT) without an explicit CCT
  const after = ac.cctAfterTakeoff ?? (ac.fp.route.toUpperCase() === "CCT" ? { rwy, tng: true } : null);
  if (after) {
    ac.cctAfterTakeoff = null;
    // the circuit flies the departure runway's pattern unless another runway was given
    ac.cct = makeCircuit(ac, after.rwy, { side: after.side, tng: after.tng, join: "UP" });
    ac.assigned.alt = ac.cct.alt;
    ac.assigned.speed = ac.cct.spd;
    ac.dep = null;
    return;
  }
  ac.dep = { rwy, route: ac.fp.route, joined: false, overridden: false };
  ac.autoFlight = ctx.simTotal; // keeps its own separation until a controller instructs it
}

/**
 * Another aircraft at this airport ahead of us in the takeoff sequence: rolling, cleared before us
 * (earlier in the list) and about to roll, or just airborne below takeoffReleaseFt.
 */
function departureAhead(ac: Aircraft, ctx: SimContext): Aircraft | null {
  const apt = ac.gnd!.apt;
  const me = ctx.aircraft.indexOf(ac);
  for (const [i, o] of ctx.aircraft.entries()) {
    if (o === ac || o.gone) continue;
    if (o.onGround) {
      if (o.gnd?.apt === apt && o.gnd.mode === "takeoff" && (o.groundSpeed > 0 || i < me)) return o;
    } else if (!o.landing && o.altitude < G.takeoffReleaseFt && o.assigned.alt > o.altitude && (o.dep?.rwy ?? o.cct?.rwy ?? "").startsWith(`${apt}-`)) return o;
  }
  return null;
}

export function stepGround(ac: Aircraft, ctx: SimContext): void {
  if (ac.gnd!.auto) stepAuto(ac, ctx);
  const gnd = ac.gnd;
  if (!gnd) return;
  switch (gnd.mode) {
    case "stand":
      ac.groundSpeed = 0;
      if (gnd.arrival && gnd.parkedSince !== null && ctx.simTotal - gnd.parkedSince >= G.standRemoveAfterSec) {
        ctx.log(`${ac.callsign} shut down on stand ${gnd.apt}-${gnd.stand}`);
        ac.gone = true;
      }
      return;
    case "holding":
    case "lined":
      ac.groundSpeed = Math.max(0, ac.groundSpeed - G.decelHoldKtPerSec);
      return;
    case "takeoff": {
      // one takeoff at a time: wait until the departure before has reached takeoffReleaseFt, and
      // (except circuits) until the climb-out keeps its separation from everyone
      const circuit = ac.cctAfterTakeoff !== null || ac.fp.route.toUpperCase() === "CCT";
      const ahead = ac.groundSpeed < 1 ? (departureAhead(ac, ctx) ?? (circuit || !gnd.rwy ? null : releaseConflict(ac, ctx, gnd.rwy))) : null;
      const des = gnd.rwy?.split("-")[1] ?? "";
      if (ahead) {
        ac.groundSpeed = 0;
        gnd.status = `CLEARED FOR TAKEOFF ${des}, WAITING FOR ${ahead.callsign}`;
        return;
      }
      if (gnd.status.startsWith("CLEARED FOR TAKEOFF")) gnd.status = `TAKING OFF ${des}`;
      takeoffRoll(ac, ctx);
      return;
    }
    case "follow":
      updateFollowPath(ac, ctx);
      if (ac.gnd?.mode !== "follow") return;
      moveAlongPath(ac, ctx);
      return;
    default:
      moveAlongPath(ac, ctx);
  }
}

// ---- commands -----------------------------------------------------------------------------------------

/** Where routing starts: the next graph node ahead when moving, else the current node. */
function routingStart(ac: Aircraft, g: GroundGraph): { node: number; prefix: PathPoint[] } {
  const gnd = ac.gnd!;
  if (gnd.path.length && ac.groundSpeed > 0) {
    const i = gnd.path.findIndex((p) => p.n !== null);
    if (i >= 0) return { node: gnd.path[i]!.n!, prefix: gnd.path.slice(0, i + 1) };
  }
  const node = gnd.node ?? nearestNode(g, ac.pos);
  if (node === null) throw reject("Unknown point");
  return { node, prefix: dist(ac.pos, g.nodes[node]!) > 1e-6 ? [{ p: g.nodes[node]!, n: node }] : [] };
}

interface PushPlan {
  points: PathPoint[];
  endHeading: number;
  noUturn: number | null;
}

/**
 * The pushback path: back along the stand lead-in to the taxiway, then a curved turn as the tail
 * swings onto the taxiway (or straight on past the end of a dead-end taxiway), or back to a picked
 * node (`to`).
 */
function pushPlan(ac: Aircraft, g: GroundGraph, stand: GStand, o: { facing?: number; to?: number }, options: GroundState["pushFacing"]): PushPlan {
  const back: PathPoint[] = [...standLeadIn(g, stand)].reverse().map((p, i, arr) => ({ p, n: i === arr.length - 1 ? stand.j : null }));
  const start = g.nodes[stand.n]!;
  if (o.to !== undefined) {
    if (o.to < 0 || o.to >= g.nodes.length) throw reject("Unknown point");
    if (o.to === stand.j || o.to === stand.n) throw reject("Pick a point further along the taxiway");
    const p = shortestPath(g, stand.j, o.to);
    if (!p) throw reject("Can't push back to that point");
    if (polylineLength(back.map((b) => b.p)) + p.length > G.pushMaxUnits)
      throw reject("Too far for a pushback: pick a closer point, or push back and taxi");
    const tail = toPathPoints(g, p);
    const last = tail[tail.length - 1]!.p;
    const prev = tail[tail.length - 2]!.p;
    return { points: smoothCorners(start, [...back, ...tail.slice(1)], G.pushTurnRadiusUnits), endHeading: aviationAngle(neg(sub(last, prev))), noUturn: null };
  }
  if (!options.length) throw reject("Can't push back to that point");
  const opt = o.facing === undefined ? options[0]! : [...options].sort((a, b) => Math.abs(angleDiff(a.hdg, o.facing!)) - Math.abs(angleDiff(b.hdg, o.facing!)))[0]!;
  const deadEnd = opt.edge < 0;
  const e = deadEnd ? g.adj[stand.j]!.map((id) => g.edges[id]!).find((x) => !x.stand)! : g.edges[opt.edge]!;
  // far enough along the taxiway for the turn and to straighten up
  const pushDist = Math.min(e.len * 0.8, lengthUnits(ac.type) * 0.6 + 0.01 + G.pushTurnRadiusUnits);
  // at a dead end the tail goes straight on past the end of the taxiway
  const J = g.nodes[stand.j]!;
  const ep = deadEnd ? [J, sub(J, scale(edgeDirFrom(e, stand.j), pushDist))] : edgePointsFrom(e, stand.j);
  const tail: PathPoint[] = [];
  let acc = 0;
  for (let i = 1; i < ep.length && acc < pushDist; i++) {
    const seg = dist(ep[i - 1]!, ep[i]!);
    if (acc + seg >= pushDist) {
      tail.push({ p: add(ep[i - 1]!, scale(normalize(sub(ep[i]!, ep[i - 1]!)), pushDist - acc)), n: null });
      acc = pushDist;
    } else {
      tail.push({ p: ep[i]!, n: null });
      acc += seg;
    }
  }
  return { points: smoothCorners(start, [...back, ...tail], G.pushTurnRadiusUnits), endHeading: opt.hdg % 360, noUturn: deadEnd ? null : opt.edge };
}

export function pushback(ac: Aircraft, _ctx: SimContext, o: { facing?: number; to?: number }): string {
  const gnd = ac.gnd!;
  const g = graphOf(ac);
  if (gnd.mode !== "stand" || !gnd.stand) throw reject("Pushback is only from a stand");
  const stand = g.standByName.get(gnd.stand);
  if (!stand) throw reject("Pushback is only from a stand");
  const plan = pushPlan(ac, g, stand, o, gnd.pushFacing);
  // first point is the stand itself (where we are)
  gnd.path = plan.points.filter((pp, i) => i > 0 || dist(pp.p, ac.pos) > 1e-6);
  gnd.mode = "push";
  gnd.reverse = true;
  gnd.endHeading = plan.endHeading;
  gnd.noUturnEdge = plan.noUturn;
  gnd.node = stand.n;
  gnd.stand = null;
  gnd.paused = false;
  gnd.pushFacing = [];
  gnd.status = `PUSHING, FACE ${heading3(plan.endHeading)}`;
  return gnd.status;
}

/** Resolve a taxi target string ("H:A1", "S:5", "T:K", "T:25L", ""). */
function resolveTarget(
  g: GroundGraph,
  target: string,
  route: string[],
): { t: TaxiTarget | null; goals: number[] | null; stand: GStand | null; shortBy: number; holdAt: true | null } {
  if (!target) return { t: route.length ? { kind: "end" } : null, goals: null, stand: null, shortBy: 0, holdAt: null };
  const kind = target[0];
  const name = target.slice(2).trim().toUpperCase();
  if (kind === "N") {
    const n = Number(name);
    if (!Number.isInteger(n) || n < 0 || n >= g.nodes.length) throw reject("Unknown point");
    return { t: { kind: "node", n }, goals: [n], stand: null, shortBy: 0, holdAt: g.holds.some((h) => h.n === n) ? true : null };
  }
  if (kind === "H") {
    const h = g.holds.find((x) => x.name === name);
    if (!h) throw reject(`Unknown hold ${target.slice(2)}`);
    return { t: { kind: "hold", name: h.name }, goals: [h.n], stand: null, shortBy: 0, holdAt: true };
  }
  if (kind === "S") {
    const s = g.standByName.get(name);
    if (!s) throw reject(`Unknown stand ${target.slice(2)}`);
    return { t: { kind: "stand", name: s.name }, goals: [s.j], stand: s, shortBy: 0, holdAt: null };
  }
  // T: hold short of a taxiway, or of a runway along the last taxiway
  const along = route.length ? route[route.length - 1]! : null;
  if (RUNWAY_DESIGNATOR.test(name)) {
    const holds = g.holds.filter((h) => pairHasDesignator(h.rwy, name) && (!along || h.twy === along));
    if (!holds.length) throw reject(`No way to hold short ${target.slice(2)} along ${along ?? "any taxiway"}`);
    return { t: { kind: "short", twy: name }, goals: holds.map((h) => h.n), stand: null, shortBy: 0, holdAt: true };
  }
  if (!g.taxiways.has(name)) throw reject(`Unknown taxiway ${target.slice(2)}`);
  const goals = holdShortNodes(g, along, name);
  if (!goals.length) throw reject(`No route to ${target.slice(2)}`);
  return { t: { kind: "short", twy: name }, goals, stand: null, shortBy: 0.04, holdAt: null };
}

export function startTaxi(ac: Aircraft, _ctx: SimContext, req: TaxiRequest): string {
  const gnd = ac.gnd!;
  const g = graphOf(ac);
  if (gnd.mode === "stand") throw reject("Push back first");
  if (gnd.mode === "lineup" || gnd.mode === "lined" || gnd.mode === "takeoff") throw reject("Already departing");
  const route = req.route.map((r) => r.toUpperCase());
  for (const r of route) if (!/^[A-Z0-9/]{1,8}$/.test(r)) throw reject("Bad route");
  for (const n of req.nodes) if (!Number.isInteger(n) || n < 0 || n >= g.nodes.length) throw reject("Unknown point");
  // picked points without a target: the last one is where the taxi ends
  const target = !req.target && req.nodes.length ? `N:${req.nodes[req.nodes.length - 1]}` : req.target;
  const resolved = resolveTarget(g, target, route);
  if (!route.length && !resolved.goals && !req.nodes.length) throw reject("Pick taxiways (or a stand)");
  if (gnd.mode === "push") {
    gnd.queued = { route, nodes: req.nodes, target };
    gnd.status = `${gnd.status.split(", THEN")[0]}, THEN TAXI${route.length ? ` VIA ${route.join(" ")}` : ""}`;
    return gnd.status;
  }
  const start = routingStart(ac, g);
  const opts = { stand: resolved.stand?.name ?? null, forbidFirstEdge: gnd.noUturnEdge };
  let path: GPath | null = null;
  if (!route.length) {
    const goals = resolved.goals ?? [];
    const via = target.startsWith("N:") && !req.target ? req.nodes.slice(0, -1) : req.nodes;
    for (const goal of goals) {
      const p = shortestPath(g, start.node, goal, opts, via);
      if (p && (!path || p.length < path.length)) path = p;
    }
    if (!path) {
      for (let k = 0; k < req.nodes.length; k++)
        if (!shortestPath(g, start.node, req.nodes[k]!, opts, req.nodes.slice(0, k)))
          throw reject(`Can't reach point ${nodeName(g, req.nodes[k]!)} from here`);
      const t = resolved.t;
      if (t?.kind === "hold") throw reject("No route to that hold");
      if (t?.kind === "stand") throw reject(`No route to stand ${t.name}`);
      throw reject(`No route to ${t?.kind === "short" ? t.twy : "that point"}`);
    }
  } else {
    const r = routeVia(g, start.node, route, resolved.goals, { ...opts, picked: req.nodes });
    if (!r.ok) {
      for (const n of req.nodes)
        if (!shortestPath(g, start.node, n, { forbidFirstEdge: gnd.noUturnEdge })) throw reject(`Can't reach point ${nodeName(g, n)} from here`);
      throw reject(r.why);
    }
    path = r.path;
  }
  let points = toPathPoints(g, path);
  if (resolved.stand) points = [...points, ...standLeadIn(g, resolved.stand).slice(1).map((p, i, a) => ({ p, n: i === a.length - 1 ? resolved.stand!.n : null }))];
  if (resolved.shortBy) points = trimEnd(points, resolved.shortBy + lengthUnits(ac.type) / 2);
  // a holding point: the nose stays behind the red line
  else if (resolved.holdAt !== null) points = trimEnd(points, holdBack(ac));
  gnd.path = smoothCorners(ac.pos, [...start.prefix.filter((pp) => pp.n !== start.node), ...points.filter((pp, i) => i > 0 || dist(pp.p, ac.pos) > 1e-6)], G.taxiTurnRadiusUnits);
  gnd.mode = "taxi";
  gnd.crossStops = crossingStops(g, path);
  gnd.target = resolved.t ?? { kind: "node", n: path.nodes[path.nodes.length - 1]! };
  if (resolved.stand) gnd.stand = resolved.stand.name;
  gnd.paused = false;
  gnd.follow = null;
  gnd.queued = null;
  gnd.noUturnEdge = null;
  gnd.status = `TAXI${route.length ? ` VIA ${route.join(" ")}` : ""} → ${targetText(g, gnd.target, route)}`;
  return gnd.status;
}

export function holdPosition(ac: Aircraft): string {
  const gnd = ac.gnd!;
  if (gnd.paused) throw reject("Already holding position");
  const moving = ["push", "taxi", "follow", "lineup", "rollout"].includes(gnd.mode) && (gnd.path.length > 0 || ac.groundSpeed > 0);
  if (!moving) throw reject("Not moving");
  gnd.paused = true;
  gnd.statusBeforeStop = gnd.status;
  gnd.status = `HOLD POSITION (${gnd.status})`;
  return gnd.status;
}

export function continueTaxi(ac: Aircraft): string {
  const gnd = ac.gnd!;
  if (!gnd.paused) throw reject("Not holding position");
  gnd.paused = false;
  gnd.status = gnd.statusBeforeStop ?? gnd.status.replace(/^HOLD POSITION \((.*)\)$/, "$1");
  gnd.statusBeforeStop = null;
  return gnd.status;
}

export function stripClimb(ctx: SimContext, cs: string): number | null {
  const s = ctx.strips[cs];
  const v = Number(s?.o_clmb ?? s?.clmb);
  return s && Number.isFinite(v) && v > 0 ? v : null;
}

export function takeoff(ac: Aircraft, ctx: SimContext, o: { runway: string; altitude?: number; wait?: boolean }): string {
  const gnd = ac.gnd!;
  const g = graphOf(ac);
  if (gnd.mode === "stand" || gnd.mode === "push") throw reject("Push back first");
  if (gnd.mode === "takeoff") throw reject("Already taking off");
  const climb = o.altitude ?? stripClimb(ctx, ac.callsign) ?? gnd.climb ?? S.defaultClimbFt;
  if (gnd.mode === "lined") {
    if (o.wait) throw reject("Already lined up");
    gnd.climb = climb;
    gnd.mode = "takeoff";
    gnd.status = `TAKING OFF ${gnd.rwy?.split("-")[1] ?? ""}, CLIMB ${climb}`;
    return gnd.status;
  }
  if (gnd.mode === "lineup") {
    gnd.wait = Boolean(o.wait);
    gnd.climb = climb;
    const des = gnd.rwy?.split("-")[1] ?? "";
    gnd.status = gnd.wait ? `LINE UP ${des} AND WAIT, CLIMB ${climb}` : `LINE UP ${des}, CLEARED FOR TAKEOFF, CLIMB ${climb}`;
    return gnd.status;
  }
  const end = findRunwayEnd(o.runway);
  if (!end || end.icao !== gnd.apt) throw reject(`Unknown runway ${o.runway}`);
  const geo = rwyEnd(end);
  const entries = entriesForRunway(g, geo.pair);
  if (!entries.length) throw reject(`No way onto ${o.runway}`);
  const start = routingStart(ac, g);
  // from (or on the way to) a holding point, line up through its own entry; a hold with no entry
  // beside it only guards a crossing
  const hold = holdsForRunway(g, geo.pair).find((h) => h.n === start.node);
  const own = hold ? entryNearHold(g, hold) : null;
  if (hold && !own) throw reject(`${hold.name} is only for crossing, no line-up from there`);
  const reachable = (own ? [own] : entries)
    .map((e) => ({ e, p: e.n === start.node ? { nodes: [e.n], edges: [], length: 0 } : shortestPath(g, start.node, e.n, { forbidFirstEdge: gnd.noUturnEdge }), d: dist(ac.pos, g.nodes[e.n]!) }))
    .filter((x): x is { e: (typeof entries)[number]; p: GPath; d: number } => x.p !== null)
    .sort((a, b) => a.d - b.d);
  if (!reachable.length) throw reject(`No way onto ${o.runway}`);
  const best = reachable[0]!;
  if (best.d > G.lineupMaxDistUnits) throw reject(`Too far from ${o.runway}: taxi to a hold first`);
  // entries sit on the runway edge: turn onto the centreline, facing the departure end
  const entryPos = g.nodes[best.e.n]!;
  const onCentreline = add(geo.start, scale(geo.dir, dot(sub(entryPos, geo.start), geo.dir)));
  const points = [...toPathPoints(g, best.p), { p: onCentreline, n: null }, { p: add(onCentreline, scale(geo.dir, 0.05)), n: null }];
  gnd.path = smoothCorners(ac.pos, [...start.prefix.filter((pp) => pp.n !== start.node), ...points.filter((pp, i) => i > 0 || dist(pp.p, ac.pos) > 1e-6)], G.taxiTurnRadiusUnits);
  gnd.mode = "lineup";
  gnd.crossStops = [];
  gnd.rwy = end.name;
  gnd.wait = Boolean(o.wait);
  gnd.climb = climb;
  gnd.endHeading = aviationAngle(geo.dir);
  gnd.paused = false;
  gnd.follow = null;
  gnd.noUturnEdge = null;
  gnd.status = gnd.wait ? `LINE UP ${end.designator} AND WAIT, CLIMB ${climb}` : `LINE UP ${end.designator}, CLEARED FOR TAKEOFF, CLIMB ${climb}`;
  return gnd.status;
}

// ---- follow ------------------------------------------------------------------------------------------

export function follow(ac: Aircraft, ctx: SimContext, o: { leader?: string; until?: string }): string {
  const gnd = ac.gnd!;
  const g = graphOf(ac);
  if (gnd.mode === "stand") throw reject("Push back first");
  if (gnd.mode === "lineup" || gnd.mode === "lined" || gnd.mode === "takeoff") throw reject("Already departing");
  if (!o.leader) throw reject("Pick an aircraft to follow");
  const leader = ctx.byId(o.leader);
  if (!leader || leader === ac || leader.gone || !leader.onGround || !leader.gnd || leader.gnd.apt !== gnd.apt)
    throw reject(`${leader && leader !== ac ? leader.callsign : "That aircraft"} is not on the ground here`);
  // refuse follow loops
  const seen = new Set<string>([ac.id]);
  let x: Aircraft | undefined = leader;
  while (x?.gnd?.follow) {
    const next = ctx.byId(x.gnd.follow.leaderId);
    if (!next) break;
    if (seen.has(next.id)) throw reject(`${x.callsign} is following ${next.callsign}`);
    seen.add(x.id);
    x = next;
  }
  if (o.until) {
    const m = /^(N|T):(.+)$/.exec(o.until);
    if (!m) throw reject("Bad follow limit");
    if (m[1] === "N") {
      const n = Number(m[2]);
      if (!Number.isInteger(n) || n < 0 || n >= g.nodes.length) throw reject("Unknown point");
    } else if (!g.taxiways.has(m[2]!.toUpperCase())) throw reject(`Unknown taxiway ${m[2]}`);
  }
  gnd.mode = "follow";
  gnd.follow = { leaderId: leader.id, until: o.until ? o.until.toUpperCase() : null, recalcAt: 0 };
  gnd.paused = false;
  gnd.target = null;
  gnd.status = `FOLLOW ${leader.callsign}${o.until ? ` TO ${o.until.slice(2).toUpperCase()}` : ""}`;
  updateFollowPath(ac, ctx, true);
  return gnd.status;
}

function updateFollowPath(ac: Aircraft, ctx: SimContext, force = false): void {
  const gnd = ac.gnd!;
  const f = gnd.follow;
  if (!f) return;
  const leader = ctx.byId(f.leaderId);
  if (!leader || leader.gone || !leader.onGround || !leader.gnd || leader.gnd.apt !== gnd.apt) {
    gnd.mode = "holding";
    gnd.status = `HOLDING (${leader?.callsign ?? "LEADER"} GONE)`;
    gnd.follow = null;
    gnd.path = [];
    return;
  }
  if (!force && ctx.simTotal < f.recalcAt) return;
  f.recalcAt = ctx.simTotal + 5;
  const g = getGroundGraph(gnd.apt)!;
  const lp = leader.gnd.path;
  const leaderNext = lp.find((p) => p.n !== null)?.n ?? leader.gnd.node ?? nearestNode(g, leader.pos);
  const leaderGoal = [...lp].reverse().find((p) => p.n !== null)?.n ?? leaderNext;
  if (leaderNext === null || leaderGoal === null) return;
  const start = routingStart(ac, g);
  const opts = { forbidFirstEdge: gnd.noUturnEdge };
  const p =
    (leaderGoal !== leaderNext ? shortestPath(g, start.node, leaderGoal, opts, [leaderNext]) : null) ??
    (start.node === leaderNext ? null : shortestPath(g, start.node, leaderNext, opts));
  let points: PathPoint[] = p ? toPathPoints(g, p) : [];
  if (f.until && points.length) {
    const [kind, val] = [f.until[0], f.until.slice(2)];
    let cut = -1;
    if (kind === "N") cut = points.findIndex((pp) => pp.n === Number(val));
    else cut = points.findIndex((pp) => pp.n !== null && pp.n !== start.node && nodeTaxiways(g, pp.n).includes(val));
    if (cut >= 0) {
      points = points.slice(0, cut + 1);
      if (kind === "T") points = trimEnd(points, 0.04 + lengthUnits(ac.type) / 2);
    }
  }
  gnd.path = smoothCorners(ac.pos, [...start.prefix.filter((pp) => pp.n !== start.node), ...points.filter((pp, i) => i > 0 || dist(pp.p, ac.pos) > 1e-6)], G.taxiTurnRadiusUnits);
  if (gnd.path.length) gnd.noUturnEdge = null;
}

// ---- AUTO, rollout, stands -------------------------------------------------------------------------------

// ---- automatic departures ----------------------------------------------------------------------------

/**
 * Script AUTO: the aircraft pushes back and taxis to the nearest holding point for the runway as
 * soon as it can do so safely. With `clr` (autodep when=cleared, DEL sweatboxes) it waits for the
 * strip clearance first, then also crosses runways, lines up and takes off by itself; with `full`
 * (autodep takeoff=auto) it does all that straight away.
 */
export function autoTaxi(ac: Aircraft, ctx: SimContext, runway: string, clr = false, full = false): void {
  const gnd = ac.gnd;
  if (!gnd || gnd.mode !== "stand" || !gnd.stand) {
    ctx.log(`AUTO ${ac.callsign}: not parked on a stand`, "warn");
    return;
  }
  const end = findRunwayEnd(runway);
  if (!end || end.icao !== gnd.apt) {
    ctx.log(`AUTO ${ac.callsign}: unknown runway ${runway}`, "warn");
    return;
  }
  gnd.auto = { rwy: end.name, primary: end.name, full: clr || full, phase: clr ? "clearance" : "push", hold: null, nextCheck: 0 };
  gnd.rwy = end.name;
  gnd.status = clr ? `ON STAND ${gnd.stand}, AWAITING CLEARANCE` : `ON STAND ${gnd.stand}, READY`;
  if (!clr) stepAuto(ac, ctx);
}

const pairKey = (apt: string, pair: string) => `${apt} ${pair.split("/").sort().join("/")}`;

/** Clearance needed between two aircraft (half of each length plus a wingtip margin). */
const clearanceBetween = (a: Aircraft, b: Aircraft) => (lengthUnits(a.type) + lengthUnits(b.type)) / 2 + G.autoClearanceUnits;

/** Where another aircraft is and is about to be on the ground (its path ahead). */
function aheadOf(o: Aircraft, maxDist: number): Vec[] {
  const pts: Vec[] = [o.pos];
  let acc = 0;
  for (const pp of o.gnd?.path ?? []) {
    acc += dist(pts[pts.length - 1]!, pp.p);
    pts.push(pp.p);
    if (acc > maxDist) break;
  }
  return pts;
}

const movingOnGround = (ac: Aircraft, o: Aircraft) =>
  o !== ac && !o.gone && o.onGround && o.gnd !== null && o.gnd.apt === ac.gnd!.apt && o.gnd.mode !== "stand";

/** Another aircraft in the way of a pushback along `pts`, or null. Parked aircraft don't count. */
function pushConflict(ac: Aircraft, ctx: SimContext, pts: Vec[]): Aircraft | null {
  for (const o of ctx.aircraft) {
    if (!movingOnGround(ac, o)) continue;
    const need = clearanceBetween(ac, o);
    if (aheadOf(o, 0.25).some((q) => projectOnPolyline(q, pts).lateral < need)) return o;
  }
  return null;
}

/** Heading of a polyline at the point nearest p. */
function directionAt(pts: Vec[], p: Vec): number {
  const i = Math.max(1, projectOnPolyline(p, pts).index);
  return bearing(pts[i - 1]!, pts[i]!);
}

/**
 * Traffic on a planned route that makes it unusable: coming the other way, or stopped across it.
 * Traffic stopped facing the same way is fine (we queue behind it).
 */
function routeConflict(ac: Aircraft, ctx: SimContext, pts: Vec[]): Aircraft | null {
  if (pts.length < 2) return null;
  for (const o of ctx.aircraft) {
    if (!movingOnGround(ac, o)) continue;
    if (["lineup", "lined", "takeoff"].includes(o.gnd!.mode)) continue; // on the runway, gone soon
    if (projectOnPolyline(o.pos, pts).lateral > 0.025) continue;
    const off = Math.abs(angleDiff(o.heading, directionAt(pts, o.pos)));
    const moving = o.groundSpeed > 0.5 || o.gnd!.path.length > 0;
    if (off > 100 || (!moving && off > 45)) return o;
  }
  return null;
}

/** Edges blocked by aircraft that sit still on the taxiways. */
function blockedEdges(ac: Aircraft, ctx: SimContext, g: GroundGraph): Set<number> {
  const out = new Set<number>();
  for (const o of ctx.aircraft) {
    if (!movingOnGround(ac, o) || o.gnd!.mode !== "holding" || o.gnd!.path.length) continue;
    for (const e of g.edges) if (!e.stand && projectOnPolyline(o.pos, e.pts).lateral < 0.02) out.add(e.id);
  }
  return out;
}

/** Who is using a runway (on it, lined up, landing or about to), or null when it is free. */
function runwayBusy(ac: Aircraft, ctx: SimContext, apt: string, pair: string, arrivalNm: number, ignoreRolling = false): Aircraft | null {
  const ends = pair
    .split("/")
    .map((d) => findRunwayEnd(`${apt}-${d}`))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));
  if (!ends.length) return null;
  const geo = rwyEnd(ends[0]!);
  const half = (getGroundGraph(apt)?.data.rwyHalfWidth ?? 0.03) + 0.01;
  const onPair = (rwy: string | null | undefined) => {
    const e = rwy ? findRunwayEnd(rwy) : undefined;
    return Boolean(e && e.icao === apt && samePair(e.pair.pair, pair));
  };
  for (const o of ctx.aircraft) {
    if (o === ac || o.gone) continue;
    if (o.onGround && o.gnd && o.gnd.apt === apt) {
      if (ignoreRolling && o.gnd.mode === "takeoff" && onPair(o.gnd.rwy)) continue;
      // an aircraft held up behind the one asking (lining up, or crossing behind it) waits for us:
      // it doesn't block us
      const waitingForUs =
        o.gnd.spacing &&
        (projectOnPolyline(ac.pos, pathAhead(o, G.spacingLookaheadUnits)).lateral <= G.spacingLateralUnits || dist(o.pos, ac.pos) <= G.spacingLookaheadUnits / 2);
      if (waitingForUs) continue;
      if (["lineup", "lined", "takeoff", "rollout"].includes(o.gnd.mode) && onPair(o.gnd.rwy)) return o;
      const onIt = (p: Vec) => {
        const along = dot(sub(p, geo.start), geo.dir);
        return along > -0.02 && along < geo.length + 0.02 && Math.abs(dot(sub(p, geo.start), perp(geo.dir))) < half;
      };
      if (onIt(o.pos)) return o;
      // cleared across it and about to enter
      if (!o.gnd.paused && (o.gnd.mode === "taxi" || o.gnd.mode === "follow") && o.groundSpeed > 0) {
        const ahead = pathAhead(o, G.crossClearUnits);
        for (let i = 1; i < ahead.length; i++)
          for (let f = 0; f <= 1; f += 0.1) if (onIt(add(ahead[i - 1]!, scale(sub(ahead[i]!, ahead[i - 1]!), f)))) return o;
      }
    } else if (!o.onGround) {
      if (o.landing && onPair(o.landing.rwy)) return o;
      const landingOn = o.approach ?? (o.cct && (o.cct.leg === "base" || o.cct.leg === "final") ? o.cct.rwy : null);
      if (!landingOn || !onPair(landingOn)) continue;
      const a = appr(findRunwayEnd(landingOn)!);
      const nm = dot(sub(o.pos, a.threshold), a.out) / S.unitsPerNm;
      if (nm > -0.5 && nm < arrivalNm) return o;
    }
  }
  return null;
}

interface AutoPlan {
  hdg: number;
  hold: string;
  path: GPath;
  push: PushPlan;
  cost: number;
}

/**
 * Holding points to depart from: they have a runway entry beside them, preferably in the first part
 * of the runway from its departure end (no intersection departures with half the runway behind
 * you). `nearEndOnly` false gives the rest too, nearest the departure end first.
 */
function departureHolds(g: GroundGraph, rwy: string, nearEndOnly = true) {
  const geo = rwyEnd(findRunwayEnd(rwy)!);
  const along = (h: (typeof g.holds)[number]) => dot(sub(g.nodes[entryNearHold(g, h)!.n]!, geo.start), geo.dir);
  return holdsForRunway(g, geo.pair)
    .filter((h) => entryNearHold(g, h) !== null && (!nearEndOnly || along(h) <= geo.length * G.autoDepHoldMaxFraction))
    .sort((a, b) => along(a) - along(b));
}

/**
 * Best push facing, holding point and taxi path for an automatic departure, around blocked taxiways.
 * Holds on the far side of the departure runway itself (reached by crossing it) only as a last
 * resort; other runway crossings count extra.
 */
function autoPlan(ac: Aircraft, ctx: SimContext, g: GroundGraph, stand: GStand, a: AutoState, nearEndOnly = true, crossOwn = false): AutoPlan | null {
  const holds = departureHolds(g, a.rwy, nearEndOnly);
  const ownPair = rwyEnd(findRunwayEnd(a.rwy)!).pair;
  const avoid = blockedEdges(ac, ctx, g);
  // aircraft already heading for each hold: spread the queue over the holds
  const queued = (name: string) => ctx.aircraft.filter((o) => o !== ac && !o.gone && o.gnd?.auto?.hold === name).length;
  let best: AutoPlan | null = null;
  for (const opt of ac.gnd!.pushFacing) {
    let push: PushPlan;
    try {
      push = pushPlan(ac, g, stand, { facing: opt.hdg }, [opt]);
    } catch {
      continue;
    }
    for (const h of holds) {
      const p = shortestPath(g, stand.j, h.n, { forbidFirstEdge: opt.edge, avoidEdges: avoid });
      if (!p) continue;
      const crossings = p.edges.map((id) => g.edges[id]!.crossing).filter((r): r is string => Boolean(r));
      if (!crossOwn && crossings.some((r) => samePair(r, ownPair))) continue;
      const cost = p.length + queued(h.name) * G.autoQueuePenaltyUnits + crossings.length * G.autoCrossPenaltyUnits;
      if (!best || cost < best.cost) best = { hdg: opt.hdg, hold: h.name, path: p, push, cost };
    }
  }
  if (best) return best;
  // no way to the holds near the start of the runway: any departure hold will do; then the far side
  if (nearEndOnly) return autoPlan(ac, ctx, g, stand, a, false, crossOwn);
  return crossOwn ? null : autoPlan(ac, ctx, g, stand, a, true, true);
}

/** Departures queued for a runway end: on their way to it, holding for it or lining up. */
function runwayQueue(ac: Aircraft, ctx: SimContext, rwy: string): number {
  return ctx.aircraft.filter(
    (o) => o !== ac && !o.gone && o.onGround && o.gnd && !o.gnd.arrival && o.gnd.rwy === rwy && ["push", "taxi", "follow", "holding", "lineup", "lined"].includes(o.gnd.mode),
  ).length;
}

/** Arrivals coming in to (or landing on) this runway end. */
function arrivalsFor(ctx: SimContext, rwy: string): boolean {
  return ctx.aircraft.some((o) => !o.gone && (o.approach === rwy || o.autoLand?.rwy === rwy || o.landing?.rwy === rwy || (o.onGround && o.gnd?.mode === "rollout" && o.gnd.rwy === rwy)));
}

/**
 * The runway for an automatic departure: the one it was given, or, when that already has
 * autoRunwayQueueMax departures queued, the next runway of the [sweatbox] settings (departure
 * runway, then the arrival runways in order) with room. An arrival runway takes departures only
 * while no arrival is coming in to it, and only autoArrivalRunwayQueueMax of them (they would sit
 * on the arrivals' way off the runway). Circuit flights keep theirs. Null: all full.
 */
function runwayWithRoom(ac: Aircraft, ctx: SimContext, a: AutoState): string | null {
  const end = findRunwayEnd(a.primary)!;
  const cfg = ctx.runwayConfig;
  const circuit = ac.cctAfterTakeoff !== null || ac.fp.route.toUpperCase() === "CCT";
  const order = !circuit && cfg && cfg.apt === end.icao && cfg.dep === end.designator ? [cfg.dep, ...cfg.arr.filter((d) => d !== cfg.dep)] : [end.designator];
  if (order.length === 1) return a.primary;
  for (const [i, d] of order.entries()) {
    const name = `${end.icao}-${d}`;
    if (!findRunwayEnd(name)) continue;
    if (i > 0 && arrivalsFor(ctx, name)) continue;
    const max = i > 0 && cfg!.arr.includes(d) && ctx.aircraft.some((o) => o.autoLand?.rwy === name || o.approach === name || o.fp.arriving === end.icao) ? G.autoArrivalRunwayQueueMax : G.autoRunwayQueueMax;
    if (runwayQueue(ac, ctx, name) < max) return name;
  }
  return null;
}

/** One second of an automatic departure: may it push, cross, line up, take off yet? */
function stepAuto(ac: Aircraft, ctx: SimContext): void {
  const gnd = ac.gnd!;
  const a = gnd.auto!;
  const g = getGroundGraph(gnd.apt)!;
  const end = findRunwayEnd(a.rwy)!;
  const geo = rwyEnd(end);
  switch (a.phase) {
    case "clearance":
      if (!ctx.strips[ac.callsign]?.c) return;
      a.phase = "push";
      a.nextCheck = ctx.simTotal + G.autoPushAfterClearSec; // a moment after the clearance
      gnd.status = "CLEARED, READY TO PUSH";
      return;
    case "push": {
      if (gnd.mode !== "stand" || !gnd.stand) {
        a.phase = "taxi";
        return;
      }
      if (ctx.simTotal < a.nextCheck) return;
      a.nextCheck = ctx.simTotal + G.autoCheckSec;
      const rwy = runwayWithRoom(ac, ctx, a);
      if (!rwy) {
        gnd.status = `ON STAND ${gnd.stand}, EVERY RUNWAY QUEUE FULL`;
        return;
      }
      a.rwy = rwy;
      const stand = g.standByName.get(gnd.stand)!;
      const plan = autoPlan(ac, ctx, g, stand, a);
      if (!plan) {
        gnd.status = `ON STAND ${gnd.stand}, ROUTE TO ${end.designator} BLOCKED`;
        return;
      }
      const pushTraffic = pushConflict(ac, ctx, [ac.pos, ...plan.push.points.map((pp) => pp.p)]);
      if (pushTraffic) {
        gnd.status = `ON STAND ${gnd.stand}, WAITING TO PUSH (${pushTraffic.callsign})`;
        return;
      }
      const routeTraffic = routeConflict(ac, ctx, toPathPoints(g, plan.path).map((pp) => pp.p));
      if (routeTraffic) {
        gnd.status = `ON STAND ${gnd.stand}, WAITING FOR ${routeTraffic.callsign}`;
        return;
      }
      pushback(ac, ctx, { facing: plan.hdg });
      a.hold = plan.hold;
      a.phase = "taxi";
      gnd.rwy = a.rwy;
      gnd.queued = { route: [], nodes: [], target: `H:${plan.hold}` };
      gnd.status = `${gnd.status}, THEN TAXI → HOLD ${plan.hold}`;
      return;
    }
    case "taxi": {
      // stopped short of a runway on the way: fully automatic departures cross when it is free
      if (gnd.paused && gnd.status.startsWith("HOLD SHORT ")) {
        if (!a.full || ctx.simTotal < a.nextCheck) return;
        a.nextCheck = ctx.simTotal + G.autoCheckSec;
        const crossing = gnd.status.slice("HOLD SHORT ".length).trim();
        // only with the runway free and room to get off it on the far side
        const room = G.crossClearUnits + 2 * lengthUnits(ac.type);
        if (!runwayBusy(ac, ctx, gnd.apt, crossing, G.autoCrossArrivalNm) && roomAhead(ac, ctx, room)) continueTaxi(ac);
        return;
      }
      if (gnd.mode !== "holding" || gnd.queued || gnd.path.length) return;
      const hold = a.hold ? g.holds.find((h) => h.name === a.hold) : undefined;
      if (hold && gnd.node === hold.n) {
        // at the holding point: the controller takes over, or it carries on by itself
        if (a.full) {
          a.phase = "depart";
          a.nextCheck = 0;
        } else gnd.auto = null;
        return;
      }
      // the taxi didn't start (or ended short): try again
      if (ctx.simTotal < a.nextCheck) return;
      a.nextCheck = ctx.simTotal + G.autoCheckSec;
      const target = hold ?? departureHolds(g, a.rwy, false)[0];
      if (!target) return;
      try {
        startTaxi(ac, ctx, { route: [], nodes: [], target: `H:${target.name}` });
        a.hold = target.name;
      } catch (e) {
        gnd.status = `HOLDING, NO ROUTE TO ${target.name} (${(e as Error).message})`;
      }
      return;
    }
    case "depart":
    case "lined": {
      if (ctx.simTotal < a.nextCheck) return;
      if (a.phase === "depart" ? gnd.mode !== "holding" : gnd.mode !== "lined") return;
      a.nextCheck = ctx.simTotal + G.autoCheckSec;
      const key = pairKey(gnd.apt, geo.pair);
      // landing traffic or anyone else on the runway: wait at the hold
      const busy = runwayBusy(ac, ctx, gnd.apt, geo.pair, G.autoArrivalClearNm, true);
      if (busy) {
        if (a.phase === "depart") gnd.status = `HOLDING SHORT ${end.designator}, WAITING FOR THE RUNWAY (${busy.callsign})`;
        return;
      }
      const rolling = runwayBusy(ac, ctx, gnd.apt, geo.pair, 0);
      const last = ctx.lastTakeoff[key];
      const tooSoon = last !== undefined && ctx.simTotal - last < G.autoDepIntervalSec;
      const traffic = ac.cctAfterTakeoff === null ? releaseConflict(ac, ctx, a.rwy) : null;
      if (traffic && !rolling && !tooSoon) {
        if (a.phase === "depart") gnd.status = `HOLDING SHORT ${end.designator}, TRAFFIC ${traffic.callsign}`;
        return;
      }
      // a runway arrivals land on: never wait on it, line up only to go straight away
      const cfg = ctx.runwayConfig;
      const arrivalRunway = Boolean(cfg && cfg.apt === gnd.apt && cfg.arr.some((d) => samePair(findRunwayEnd(`${gnd.apt}-${d}`)?.pair.pair ?? "", geo.pair)));
      const waitFor = rolling ?? departureAhead(ac, ctx);
      try {
        if (waitFor || tooSoon) {
          // line up and wait behind the departure ahead
          if (a.phase === "depart") {
            if (arrivalRunway) {
              gnd.status = `HOLDING SHORT ${end.designator}, WAITING FOR ${waitFor?.callsign ?? "THE DEPARTURE AHEAD"}`;
              return;
            }
            takeoff(ac, ctx, { runway: a.rwy, wait: true });
            a.phase = "lined";
          }
          return;
        }
        takeoff(ac, ctx, { runway: a.rwy });
        ctx.lastTakeoff[key] = ctx.simTotal;
        gnd.auto = null;
      } catch (e) {
        gnd.status = `HOLDING SHORT ${end.designator} (${(e as Error).message})`;
      }
      return;
    }
  }
}

/**
 * After touchdown with ROLLOUT HOLD/STAND: decelerate down the runway and vacate on the side
 * nearer the stands. Returns false when the airport has no ground map (the caller removes the
 * aircraft as LANDED instead).
 */
export function startRollout(ac: Aircraft, ctx: SimContext, rwy: string): boolean {
  const end = findRunwayEnd(rwy);
  const g = end ? getGroundGraph(end.icao) : undefined;
  if (!end || !g) return false;
  const geo = rwyEnd(end);
  // never vacate into a dead end, such as a turnaround loop with no way to the stands
  const entries = entriesForRunway(g, geo.pair).filter((e) => !g.stands.length || g.stands.some((st) => shortestPath(g, e.n, st.j) !== null));
  if (!entries.length) return false;
  const right = perp(geo.dir);
  const standSide = g.stands.length
    ? Math.sign(g.stands.reduce((s, st) => s + dot(sub(g.nodes[st.n]!, geo.start), right), 0))
    : 0;
  const along = (n: number) => dot(sub(g.nodes[n]!, geo.start), geo.dir);
  const here = dot(sub(ac.pos, geo.start), geo.dir);
  const stopDist = (ac.groundSpeed ** 2 - G.rolloutExitKt ** 2) / (2 * G.rolloutDecelKtPerSec) / 3600;
  const minS = Math.max(here + stopDist, geo.length * 0.5);
  // entries sit on the runway edges: their side of the centreline is the side you vacate to
  const side = (e: (typeof entries)[number]) => Math.sign(dot(sub(g.nodes[e.n]!, geo.start), right));
  const ahead = entries.filter((e) => along(e.n) >= minS && along(e.n) <= geo.length + 0.05);
  // an exit whose holding point (the way off) has someone waiting at it is no way off
  const exitHold = (e: (typeof entries)[number]) =>
    g.holds.filter((h) => h.twy === e.twy && samePair(h.rwy, geo.pair)).sort((p, q) => dist(g.nodes[p.n]!, g.nodes[e.n]!) - dist(g.nodes[q.n]!, g.nodes[e.n]!))[0];
  const clear = (e: (typeof entries)[number]) => {
    const h = exitHold(e);
    const spot = h ? g.nodes[h.n]! : g.nodes[e.n]!;
    return !ctx.aircraft.some((o) => o !== ac && !o.gone && o.onGround && o.gnd?.apt === g.icao && o.gnd.mode !== "stand" && dist(o.pos, spot) < G.exitClearUnits);
  };
  const preferred = ahead.filter((e) => standSide === 0 || side(e) === standSide);
  const tiers = [preferred.filter(clear), ahead.filter(clear), preferred, ahead];
  const pool = tiers.find((t) => t.length) ?? [...entries].sort((a, b) => along(b.n) - along(a.n)).slice(0, 1);
  const exit = pool[Math.floor(ctx.random() * pool.length)]!;
  // runway part: straight down the centreline to the exit node
  const exitPos = g.nodes[exit.n]!;
  const onRunway: PathPoint[] = [{ p: add(geo.start, scale(geo.dir, Math.max(here, along(exit.n)))), n: null }, { p: exitPos, n: exit.n }];
  // then along the exit taxiway to the hold, and half an aircraft length past the hold line
  const hold = g.holds
    .filter((h) => h.twy === exit.twy && samePair(h.rwy, geo.pair))
    .sort((a, b) => dist(g.nodes[a.n]!, exitPos) - dist(g.nodes[b.n]!, exitPos))[0];
  let taxiPart: PathPoint[] = [];
  if (hold) {
    const p = shortestPath(g, exit.n, hold.n);
    if (p) {
      taxiPart = toPathPoints(g, p).slice(1);
      const beyond = g.adj[hold.n]!.map((id) => g.edges[id]!).find((e) => !e.stand && !p.edges.includes(e.id) && !e.runway);
      if (beyond) {
        const ep = edgePointsFrom(beyond, hold.n);
        const d = Math.min(lengthUnits(ac.type) / 2 + 0.01, beyond.len * 0.9);
        taxiPart.push({ p: add(ep[0]!, scale(normalize(sub(ep[1]!, ep[0]!)), d)), n: null });
      }
    }
  }
  ac.onGround = true;
  ac.altitude = 0;
  ac.approach = null;
  ac.apprCaptured = false;
  ac.cct = null;
  ac.landing = null;
  ac.heading = aviationAngle(geo.dir);
  const path = smoothCorners(ac.pos, [...onRunway, ...taxiPart].filter((pp, i) => i > 0 || dist(pp.p, ac.pos) > 1e-6), G.taxiTurnRadiusUnits);
  const totalAfterExit = polylineLength([exitPos, ...taxiPart.map((t) => t.p)]);
  ac.gnd = newGroundState(g.icao, {
    mode: "rollout",
    status: `ROLLOUT ${end.designator}, VACATE VIA ${exit.twy}`,
    path,
    rwy: end.name,
    arrival: true,
    rolloutExitAt: totalAfterExit + 0.005,
  });
  return true;
}

/** ROLLOUT STAND: taxi to the requested stand, or the nearest free one (up to 6 candidates). */
export function taxiToStand(ac: Aircraft, ctx: SimContext): void {
  const gnd = ac.gnd!;
  const g = getGroundGraph(gnd.apt)!;
  const strip = ctx.strips[ac.callsign];
  const requested = (strip?.o_stand ?? strip?.stand ?? "").toUpperCase();
  const free = (s: GStand) => standFree(ctx, ac, g.icao, s.name);
  const byDistance = [...g.stands].filter(free).sort((a, b) => dist(g.nodes[a.n]!, ac.pos) - dist(g.nodes[b.n]!, ac.pos));
  const req = g.standByName.get(requested);
  const candidates = req && free(req) ? [req] : byDistance.slice(0, G.standCandidates);
  for (const stand of candidates) {
    try {
      startTaxi(ac, ctx, { route: [], nodes: [], target: `S:${stand.name}` });
      gnd.stand = stand.name;
      return;
    } catch {
      // try the next stand
    }
  }
  gnd.status = `${gnd.status}, NO FREE STAND`;
  ctx.log(`${ac.callsign}: no free stand reachable at ${gnd.apt}`, "warn");
}

/** Planned path for display (hosts), current position first. */
export function plannedPath(ac: Aircraft): [number, number][] {
  if (!ac.gnd) return [];
  return [[ac.pos.x, ac.pos.y], ...ac.gnd.path.map((pp) => [pp.p.x, pp.p.y] as [number, number])];
}
