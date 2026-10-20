// Airborne flight model (spec 5.3). One call = one simulated second.
import { config } from "@sweatbox/config";
import {
  add,
  airportRef,
  alongTrackNm,
  angleDiff,
  appr,
  bearing,
  crossTrackSigned,
  DEG,
  dist,
  dot,
  findRunwayEnd,
  fromAviationAngle,
  norm360,
  perp,
  scale,
  sub,
  type Vec,
} from "@sweatbox/shared";
import type { Aircraft } from "./types";
import type { SimContext } from "./context";
import { circuitSteer } from "./circuit";
import { holdSteer } from "./hold";

const S = config.sim;
const U = S.unitsPerNm;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Radius of a standard-rate turn at this ground speed, in map units. */
export function turnRadiusUnits(gs: number): number {
  return gs / 3600 / (S.turnDegPerSec * DEG);
}

/** Heading that captures and follows the line through `point` with course `course`. */
export function lineSteer(pos: Vec, point: Vec, course: number, maxIntercept: number = S.interceptMaxDeg): number {
  const right = perp(fromAviationAngle(course));
  const rightNm = dot(sub(pos, point), right) / U;
  return norm360(course - clamp(rightNm * S.interceptDegPerNm, -maxIntercept, maxIntercept));
}

/** 3 degree glidepath altitude at `dNm` from the threshold (never below 0). */
export function glideAltitude(dNm: number): number {
  return Math.max(dNm, 0) * S.ftPerNm * Math.tan(S.glideslopeDeg * DEG);
}

/**
 * Steering for a cleared approach (or the circuit final) to a runway end. Also lowers the assigned
 * altitude to the glidepath and caps the speed on short final. Returns the target heading.
 */
export function steerOnFinal(ac: Aircraft, rwy: string): number {
  const end = findRunwayEnd(rwy);
  if (!end) return ac.assigned.heading;
  const a = appr(end);
  const d = alongTrackNm(a, ac.pos);
  const xs = crossTrackSigned(a, ac.pos);
  const xt = Math.abs(xs);
  const dh = angleDiff(ac.heading, a.course);
  // lateral distance needed to roll out on the centreline from the current heading
  const R = turnRadiusUnits(ac.groundSpeed) * (1 - Math.cos(dh * DEG));
  let target: number;
  if (!ac.apprCaptured && xt > R) {
    target = ac.assigned.heading; // keep flying the heading until the turn-on point
  } else {
    ac.apprCaptured = true;
    // steer onto the final course, with a gentle correction toward the centreline
    target = norm360(a.course + clamp((xs / U) * S.interceptDegPerNm, -30, 30));
    if (xt < S.approachSnapUnits && Math.abs(dh) < 45) {
      ac.pos = add(a.threshold, scale(a.out, dot(sub(ac.pos, a.threshold), a.out)));
      ac.heading = a.course;
      target = a.course;
    }
  }
  ac.assigned.alt = Math.min(ac.assigned.alt, glideAltitude(d));
  if (d <= S.approachSpeedWithinNm) ac.assigned.speed = Math.min(ac.assigned.speed, S.approachSpeedKt);
  return target;
}

/** Steer to the first fix; pop it when passed. */
function fixSteer(ac: Aircraft): number | null {
  while (ac.fixList.length) {
    const f = ac.fixList[0]!;
    if (dist(ac.pos, f.pos) > S.fixPassNm * U) return bearing(ac.pos, f.pos);
    ac.fixList.shift();
  }
  // route finished: carry on with the current heading
  ac.assigned.heading = Math.round(ac.heading) || 360;
  return null;
}

/** Integrate altitude, speed, heading and position for one second. */
export function integrate(ac: Aircraft, target: number, forced: "L" | "R" | null = null): void {
  ac.altitude += clamp(ac.assigned.alt - ac.altitude, -S.climbFtPerSec, S.climbFtPerSec);
  ac.groundSpeed += clamp(ac.assigned.speed - ac.groundSpeed, -S.accelKtPerSec, S.accelKtPerSec);
  let diff = angleDiff(ac.heading, target);
  // forced turn direction (holds): go the long way round when needed
  if (forced === "R" && diff < -30) diff += 360;
  if (forced === "L" && diff > 30) diff -= 360;
  ac.heading = norm360(ac.heading + clamp(diff, -S.turnDegPerSec, S.turnDegPerSec));
  ac.pos = add(ac.pos, fromAviationAngle(ac.heading, ac.groundSpeed / 3600));
}

export function stepAirborne(ac: Aircraft, ctx: SimContext): void {
  let target = ac.assigned.heading;
  let forced: "L" | "R" | null = null;
  if (ac.cct) {
    target = circuitSteer(ac, ctx);
  } else if (ac.approach) {
    target = steerOnFinal(ac, ac.approach);
  } else if (ac.hold) {
    const h = holdSteer(ac);
    target = h.heading;
    forced = h.forced;
  } else if (ac.fixList.length) {
    target = fixSteer(ac) ?? ac.assigned.heading;
  } else if (ac.homing && ac.arr) {
    const ref = airportRef(ac.arr);
    if (ref) target = bearing(ac.pos, ref);
  }
  if (ac.assigned.alt <= S.speedCapBelowFt) ac.assigned.speed = Math.min(ac.assigned.speed, S.speedCapKt);
  integrate(ac, target, forced);
}
