// Holds (spec 5.9): direct entry at a fix, or at the present position (PPOS).
import { config } from "@sweatbox/config";
import { angleDiff, bearing, dist, dot, fromAviationAngle, getFix, sub } from "@sweatbox/shared";
import type { Aircraft, HoldState } from "./types";
import { lineSteer } from "./air";
import { reject } from "../errors";

const H = config.sim.hold;
const PASS = config.sim.fixPassNm * config.sim.unitsPerNm;

export interface HoldOptions {
  fix?: string;
  course?: number;
  turn?: "L" | "R";
  leg?: number;
  alt?: number;
  spd?: number;
}

export function startHold(ac: Aircraft, o: HoldOptions): HoldState {
  if (ac.onGround) throw reject("Can't hold on the ground");
  const ppos = !o.fix || o.fix === "PPOS";
  let pos = ac.pos;
  let name = "PPOS";
  let resume = ac.fixList.slice(0, 0);
  if (!ppos) {
    // a fix from the table, or a point on the current route (generated waypoints)
    const onRoute = ac.fixList.findIndex((f) => f.name === o.fix);
    const fix = getFix(o.fix!) ?? (onRoute >= 0 ? ac.fixList[onRoute] : undefined);
    if (!fix) throw reject(`Unknown fix ${o.fix}`);
    pos = fix.pos;
    name = fix.name;
    resume = onRoute >= 0 ? ac.fixList.slice(onRoute + 1) : [];
  }
  const crs = o.course ?? (ppos ? Math.round(ac.heading) || 360 : Math.round(bearing(ac.pos, pos)) || 360);
  const leg = Math.min(H.maxLegSec, Math.max(H.minLegSec, o.leg ?? H.defaultLegSec));
  const hold: HoldState = {
    fix: name,
    pos: { ...pos },
    crs,
    dir: o.turn ?? H.defaultTurn,
    leg,
    ph: ppos ? "turn" : "entry",
    turnTo: (crs + 180) % 360,
    next: "out",
    t: 0,
    resume,
  };
  ac.hold = hold;
  ac.fixList = [];
  ac.approach = null;
  ac.apprCaptured = false;
  ac.cct = null;
  ac.homing = false;
  if (ac.dep) ac.dep.overridden = true;
  if (o.alt !== undefined) ac.assigned.alt = o.alt;
  if (o.spd !== undefined) ac.assigned.speed = Math.min(H.maxSpeedKt, Math.max(H.minSpeedKt, o.spd));
  return hold;
}

/** Leave the hold: resume the route after the hold fix, or keep the current heading. */
export function leaveHold(ac: Aircraft): void {
  const h = ac.hold;
  if (!h) throw reject("Not holding");
  ac.hold = null;
  if (h.resume.length) ac.fixList = h.resume;
  else ac.assigned.heading = Math.round(ac.heading) || 360;
}

export function holdSteer(ac: Aircraft): { heading: number; forced: "L" | "R" | null } {
  const h = ac.hold!;
  switch (h.ph) {
    case "entry":
      if (dist(ac.pos, h.pos) <= PASS) {
        h.ph = "turn";
        h.turnTo = (h.crs + 180) % 360;
        h.next = "out";
        return { heading: h.turnTo, forced: h.dir };
      }
      return { heading: bearing(ac.pos, h.pos), forced: null };
    case "turn":
      if (Math.abs(angleDiff(ac.heading, h.turnTo)) < 1) {
        h.ph = h.next;
        h.t = 0;
      }
      return { heading: h.turnTo, forced: h.dir };
    case "out":
      h.t += 1;
      if (h.t >= h.leg) {
        h.ph = "turn";
        h.turnTo = h.crs;
        h.next = "in";
      }
      return { heading: (h.crs + 180) % 360, forced: null };
    case "in": {
      const passed = dot(sub(ac.pos, h.pos), fromAviationAngle(h.crs)) >= 0;
      if (passed || dist(ac.pos, h.pos) <= PASS) {
        h.ph = "turn";
        h.turnTo = (h.crs + 180) % 360;
        h.next = "out";
        return { heading: h.turnTo, forced: h.dir };
      }
      return { heading: lineSteer(ac.pos, h.pos, h.crs), forced: null };
    }
  }
}
