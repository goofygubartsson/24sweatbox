// Landing, flare / rollout, TWR landing clearances and go-arounds (spec 5.6, 5.7).
import { config } from "@sweatbox/config";
import { add, alongTrackNm, appr, aviationAngle, dot, findRunwayEnd, getGroundGraph, isGaType, rwyEnd, scale, sub } from "@sweatbox/shared";
import type { Aircraft } from "./types";
import type { SimContext } from "./context";
import { makeCircuit, restartUpwind } from "./circuit";
import { startRollout } from "./ground";

const S = config.sim;
const T = config.twr;

/** Runway end the aircraft is landing on (approach, or circuit final), or null. */
export function landingRunway(ac: Aircraft): string | null {
  if (ac.cct) return ac.cct.leg === "final" ? ac.cct.rwy : null;
  return ac.approach;
}

/** TWR mode is the session's own tower: landing clearances are needed only on its airport's runways. */
const towerRunway = (rwy: string, ctx: SimContext): boolean => !ctx.airport || rwy.startsWith(`${ctx.airport}-`);

/** Step 3 of the tick: airborne at or below 100 ft and not flaring -> landed (or touch-and-go). */
export function landingCheck(ac: Aircraft, ctx: SimContext): void {
  if (ac.onGround || ac.landing || ac.gone) return;
  if (ac.altitude > S.landedBelowFt) return;
  const rwy = landingRunway(ac);
  // just went around low (climbing away), or low on another circuit leg: not a landing
  if (!rwy && (ac.cct || ac.assigned.alt > ac.altitude)) return;
  // TWR mode: no clearance, no landing. The go-around check below takes care of it.
  if (rwy && ctx.twrMode && !ac.landClr && towerRunway(rwy, ctx)) return;
  if (ac.cct && ac.cct.leg === "final" && ac.cct.tng) {
    touchAndGo(ac, ctx);
    return;
  }
  if (rwy && ctx.rolloutMode !== "OFF" && config.features.ground) {
    const end = findRunwayEnd(rwy);
    if (end && getGroundGraph(end.icao)) {
      ac.landing = { phase: "flare", rwy: end.name };
      return;
    }
  }
  ctx.log(`LANDED ${ac.callsign}${rwy ? ` ${rwy}` : ""}`);
  ctx.counters.landed++;
  ac.gone = true;
}

function touchAndGo(ac: Aircraft, ctx: SimContext): void {
  ctx.log(`TOUCH AND GO ${ac.callsign} ${ac.cct!.rwy}`);
  restartUpwind(ac);
  ac.altitude = S.landedBelowFt + 1;
}

/** Flare: follow the centreline down to the touchdown point, then roll out on the ground. */
export function stepFlare(ac: Aircraft, ctx: SimContext): void {
  const end = findRunwayEnd(ac.landing!.rwy)!;
  const a = appr(end);
  ac.heading = a.course;
  // stay on the centreline
  ac.pos = add(a.threshold, scale(a.out, dot(sub(ac.pos, a.threshold), a.out)));
  ac.groundSpeed = Math.max(config.ground.rolloutTouchdownKt, ac.groundSpeed - S.accelKtPerSec);
  const remainingNm = alongTrackNm(a, ac.pos) + S.flareTouchdownNm;
  const ticks = (remainingNm * 3600) / Math.max(1, ac.groundSpeed);
  ac.altitude = ticks > 1 ? Math.max(0, ac.altitude - ac.altitude / ticks) : 0;
  ac.pos = add(ac.pos, scale(sub({ x: 0, y: 0 }, a.out), ac.groundSpeed / 3600));
  if (alongTrackNm(a, ac.pos) <= -S.flareTouchdownNm) {
    ctx.log(`LANDED ${ac.callsign} ${end.name}`);
    ctx.counters.landed++;
    if (!startRollout(ac, ctx, end.name)) ac.gone = true;
  }
}

/** Step 4: TWR mode, approaching without a landing clearance -> go around. */
export function twrCheck(ac: Aircraft, ctx: SimContext): void {
  if (!ctx.twrMode || ac.onGround || ac.landing || ac.landClr || ac.gone) return;
  const rwy = landingRunway(ac);
  if (!rwy || !towerRunway(rwy, ctx)) return;
  const end = findRunwayEnd(rwy);
  if (!end) return;
  const d = alongTrackNm(appr(end), ac.pos);
  const limit = ac.cct ? T.circuitGoAroundNm : T.goAroundIfNoClearanceNm;
  if (d <= limit && d > -1) goAround(ac, ctx, "no landing clearance");
}

/**
 * Go-around: runway heading, climb to 3000 ft at least 180 kt. In TWR mode, without a circuit, fly a
 * circuit back to the same runway (GA types at circuit height, others at 1500 ft / 160 kt). Already
 * in the circuit: back to upwind.
 */
export function goAround(ac: Aircraft, ctx: SimContext, reason?: string): void {
  const rwy = landingRunway(ac) ?? ac.cct?.rwy ?? ac.approach;
  ctx.log(`GO AROUND ${ac.callsign}${rwy ? ` ${rwy}` : ""}${reason ? ` (${reason})` : ""}`, "warn");
  ac.approach = null;
  ac.apprCaptured = false;
  ac.landClr = false;
  ac.fixList = [];
  ac.hold = null;
  ac.homing = false;
  ac.landing = null;
  const end = rwy ? findRunwayEnd(rwy) : undefined;
  const hdg = end ? Math.round(aviationAngle(rwyEnd(end).dir)) || 360 : Math.round(ac.heading) || 360;
  if (ac.cct) {
    restartUpwind(ac);
    return;
  }
  if (ctx.twrMode && end) {
    const ga = isGaType(ac.type);
    ac.cct = makeCircuit(ac, end.name, {
      tng: false,
      join: "UP",
      alt: ga ? config.circuit.altFt : T.gaCircuitJetAltFt,
      spd: ga ? config.circuit.gaSpeedKt : T.gaCircuitJetSpeedKt,
    });
    ac.assigned = { alt: ac.cct.alt, heading: hdg, speed: ac.cct.spd };
    return;
  }
  ac.assigned.heading = hdg;
  ac.assigned.alt = S.gaClimbFt;
  ac.assigned.speed = Math.max(ac.assigned.speed, S.gaSpeedKt);
}
