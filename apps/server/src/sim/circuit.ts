// Circuits (spec 5.8): upwind -> crosswind -> downwind -> base -> final, flown in a runway frame:
// s = distance along the landing direction from the threshold, l = distance toward the pattern side.
import { config } from "@sweatbox/config";
import {
  add,
  angleDiff,
  aviationAngle,
  bearing,
  dist,
  dot,
  findRunwayEnd,
  isGaType,
  neg,
  perp,
  runwaysOf,
  rwyEnd,
  scale,
  sub,
  type JoinLeg,
  type Vec,
} from "@sweatbox/shared";
import type { Aircraft, CircuitState } from "./types";
import type { SimContext } from "./context";
import { lineSteer, steerOnFinal, turnRadiusUnits } from "./air";
import { reject } from "../errors";

const C = config.circuit;
const U = config.sim.unitsPerNm;

const leftOf = (u: Vec): Vec => ({ x: u.y, y: -u.x });

interface Frame {
  T: Vec;
  u: Vec;
  v: Vec;
  len: number;
  heading: number;
}

export function circuitFrame(rwy: string, side: "L" | "R"): Frame | null {
  const end = findRunwayEnd(rwy);
  if (!end) return null;
  const g = rwyEnd(end);
  return { T: g.start, u: g.dir, v: side === "L" ? leftOf(g.dir) : perp(g.dir), len: g.length, heading: aviationAngle(g.dir) };
}

/** Pattern side away from parallel runways; left when there are none or some on both sides. */
export function defaultPatternSide(rwy: string): "L" | "R" {
  const end = findRunwayEnd(rwy);
  if (!end) return "L";
  const g = rwyEnd(end);
  const mid = scale(add(g.start, g.end), 0.5);
  let left = false;
  let right = false;
  for (const other of runwaysOf(end.icao)) {
    if (other === end.pair) continue;
    const h = aviationAngle(sub(other.position2, other.position1));
    const delta = Math.abs(angleDiff(h, aviationAngle(g.dir)));
    if (Math.min(delta, 180 - delta) > C.parallelMaxDeg) continue;
    const off = dot(sub(scale(add(other.position1, other.position2), 0.5), mid), perp(g.dir));
    if (off > 0) right = true;
    else if (off < 0) left = true;
  }
  if (right && !left) return "L";
  if (left && !right) return "R";
  return "L";
}

export interface PatternOptions {
  side?: "L" | "R";
  tng?: boolean;
  join?: JoinLeg;
  alt?: number;
  spd?: number;
}

/** A fresh circuit for this aircraft on runway end `rwy`. Throws 409 for an unknown runway. */
export function makeCircuit(ac: Aircraft, rwy: string, opts: PatternOptions = {}): CircuitState {
  const end = findRunwayEnd(rwy);
  if (!end) throw reject(`Unknown runway ${rwy}`);
  const g = rwyEnd(end);
  const ga = isGaType(ac.type);
  const side = opts.side ?? defaultPatternSide(rwy);
  const join = opts.join ?? "DW";
  const legByJoin = { DW: "down", DOWN: "down", BASE: "base", UP: "up", CROSS: "cross" } as const;
  return {
    rwy: end.name,
    side,
    leg: legByJoin[join],
    tng: opts.tng ?? true,
    alt: opts.alt ?? C.altFt,
    spd: opts.spd ?? (ga ? C.gaSpeedKt : C.jetSpeedKt),
    vr: ga ? C.gaRotateKt : C.jetRotateKt,
    ext: false,
    ...defaultAnchors(ac, g.length),
    joining: join === "DW",
  };
}

function defaultAnchors(ac: Aircraft, len: number) {
  const ga = isGaType(ac.type);
  return {
    sUp: len + C.upwindNm * U,
    lDown: (ga ? C.gaWidthNm : C.jetWidthNm) * U,
    sBase: -(ga ? C.gaBaseNm : C.jetBaseNm) * U,
  };
}

/** Back to upwind after a touch-and-go or go-around, with the default pattern size. */
export function restartUpwind(ac: Aircraft): void {
  const cct = ac.cct;
  if (!cct) return;
  const end = findRunwayEnd(cct.rwy);
  if (!end) return;
  Object.assign(cct, { leg: "up", ext: false, joining: false }, defaultAnchors(ac, rwyEnd(end).length));
  ac.landClr = false;
  ac.apprCaptured = false;
  ac.assigned.alt = cct.alt;
  ac.assigned.speed = cct.spd;
  ac.assigned.heading = Math.round(rwyEnd(end).heading) || 360;
}

const LEG_NAMES = { up: "upwind", cross: "crosswind", down: "downwind", base: "base", final: "final" } as const;
export const legName = (leg: keyof typeof LEG_NAMES): string => LEG_NAMES[leg];

/** Target heading for this tick; advances legs. */
export function circuitSteer(ac: Aircraft, _ctx: SimContext): number {
  const cct = ac.cct!;
  const f = circuitFrame(cct.rwy, cct.side);
  if (!f) {
    ac.cct = null;
    return ac.assigned.heading;
  }
  const rel = sub(ac.pos, f.T);
  const s = dot(rel, f.u);
  const l = dot(rel, f.v);
  const R = turnRadiusUnits(ac.groundSpeed);
  const maxExt = C.extendMaxNm * U;
  const courseV = aviationAngle(f.v);
  const courseBack = aviationAngle(neg(f.v));
  if (cct.leg !== "final") {
    ac.assigned.alt = cct.alt;
    ac.assigned.speed = cct.spd;
  }
  switch (cct.leg) {
    case "up": {
      if (cct.ext ? s >= f.len + maxExt : s >= cct.sUp) {
        if (cct.ext) cct.sUp = s;
        cct.ext = false;
        cct.leg = "cross";
      }
      return lineSteer(ac.pos, f.T, f.heading);
    }
    case "cross": {
      if (cct.ext ? l >= maxExt : l >= cct.lDown - R) {
        if (cct.ext) cct.lDown = l + R;
        cct.ext = false;
        cct.leg = "down";
      }
      return lineSteer(ac.pos, add(f.T, scale(f.u, cct.sUp)), courseV);
    }
    case "down": {
      const downCourse = (f.heading + 180) % 360;
      if (cct.joining) {
        // standard downwind join: fly to the downwind abeam midfield, then turn downwind
        const J = add(add(f.T, scale(f.u, f.len / 2)), scale(f.v, cct.lDown));
        const near = dist(ac.pos, J) < 1.5 * R || (Math.abs(l - cct.lDown) < R && Math.abs(angleDiff(ac.heading, downCourse)) < 90);
        if (!near && s > cct.sBase + R) return bearing(ac.pos, J);
        cct.joining = false;
      }
      if (cct.ext ? s <= -maxExt : s <= cct.sBase + R) {
        if (cct.ext) cct.sBase = s - R;
        cct.ext = false;
        cct.leg = "base";
      }
      return lineSteer(ac.pos, add(f.T, scale(f.v, cct.lDown)), downCourse);
    }
    case "base": {
      if (l <= R) {
        cct.leg = "final";
        ac.apprCaptured = false;
      }
      return lineSteer(ac.pos, add(f.T, scale(f.u, cct.sBase)), courseBack);
    }
    case "final": {
      ac.assigned.alt = Math.min(ac.assigned.alt, cct.alt);
      ac.assigned.speed = Math.min(ac.assigned.speed, cct.spd);
      return steerOnFinal(ac, cct.rwy);
    }
  }
}

/** "ext": extend the current leg, or "turn now" when it is already extended. */
export function extendOrTurn(ac: Aircraft, ctx: SimContext): string {
  const cct = ac.cct;
  if (!cct) throw reject("Not in the circuit");
  if (cct.leg !== "up" && cct.leg !== "cross" && cct.leg !== "down")
    throw reject("Only the upwind, crosswind or downwind leg can be extended");
  if (!cct.ext) {
    cct.ext = true;
    ctx.log(`${ac.callsign} extend ${legName(cct.leg)}`, "host");
    return `EXTEND ${legName(cct.leg).toUpperCase()}`;
  }
  // turn now: the next leg starts here
  const f = circuitFrame(cct.rwy, cct.side)!;
  const rel = sub(ac.pos, f.T);
  const R = turnRadiusUnits(ac.groundSpeed);
  if (cct.leg === "up") {
    cct.sUp = dot(rel, f.u);
    cct.leg = "cross";
  } else if (cct.leg === "cross") {
    cct.lDown = dot(rel, f.v) + R;
    cct.leg = "down";
  } else {
    cct.sBase = dot(rel, f.u) - R;
    cct.leg = "base";
    cct.joining = false;
  }
  cct.ext = false;
  ctx.log(`${ac.callsign} turn ${legName(cct.leg)} now`, "host");
  return `TURN ${legName(cct.leg).toUpperCase()} NOW`;
}
