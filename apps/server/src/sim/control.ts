// Host aircraft instructions (spec 15.3). Each handler validates, applies, and returns the audit
// action + value ("HOST <ACT> <CS> → <value>"). Rejections are 409 texts shown to the host verbatim.
import { config } from "@sweatbox/config";
import { angleDiff, appr, findRunwayEnd, getFix, heading3, type AirBody, type GndBody, type TwrBody } from "@sweatbox/shared";
import type { Aircraft, FixPoint } from "./types";
import type { SimContext } from "./context";
import { badInput, reject } from "../errors";
import { continueTaxi, follow, holdPosition, pushback, startTaxi, takeoff } from "./ground";
import { extendOrTurn, makeCircuit } from "./circuit";
import { leaveHold, startHold } from "./hold";
import { goAround } from "./landing";

export type HostAct = "ALT" | "HDG" | "SPD" | "DCT" | "APPR" | "GND" | "TWR" | "CCT" | "HOLD" | "EMER" | "DEL";

export interface ControlResult {
  act: HostAct;
  value: string;
}

/** Everything a heading / direct / approach / hold / circuit instruction cancels. */
function cancelNavigation(ac: Aircraft): void {
  ac.fixList = [];
  ac.approach = null;
  ac.apprCaptured = false;
  ac.hold = null;
  ac.homing = false;
  if (ac.dep) ac.dep.overridden = true;
}

/** Heading the aircraft is actually steering for (assigned heading unless it follows a route). */
function effectiveHeading(ac: Aircraft): number {
  return ac.fixList.length || ac.homing || ac.hold || ac.cct ? ac.heading : ac.assigned.heading;
}

export function toggleEmergency(ac: Aircraft, ctx: SimContext): boolean {
  ac.emergency = !ac.emergency;
  ctx.log(`EMERGENCY ${ac.callsign} ${ac.emergency ? "declared" : "cancelled"}`, ac.emergency ? "warn" : "info");
  return ac.emergency;
}

export function clearApproach(ac: Aircraft, rwy: string): void {
  cancelNavigation(ac);
  ac.cct = null;
  ac.approach = rwy;
}

export function airControl(ac: Aircraft, body: AirBody, ctx: SimContext): ControlResult {
  if (body.emer) return { act: "EMER", value: toggleEmergency(ac, ctx) ? "ON" : "OFF" };
  if (body.del) {
    ac.gone = true;
    ctx.counters.deleted++;
    ctx.log(`DELETED ${ac.callsign}`);
    return { act: "DEL", value: "DELETED" };
  }
  if (ac.onGround) throw reject("Aircraft is on the ground");
  if (body.alt !== undefined) {
    ac.assigned.alt = body.alt;
    ac.approach = null;
    ac.apprCaptured = false;
    return { act: "ALT", value: String(body.alt) };
  }
  if (body.hdg !== undefined) {
    cancelNavigation(ac);
    ac.cct = null;
    ac.assigned.heading = body.hdg;
    return { act: "HDG", value: heading3(body.hdg) };
  }
  if (body.spd !== undefined) {
    ac.assigned.speed = body.spd;
    return { act: "SPD", value: String(body.spd) };
  }
  if (body.dct !== undefined) {
    const points: FixPoint[] = [];
    for (const name of body.dct) {
      const onRoute = ac.fixList.find((f) => f.name === name);
      const fix = getFix(name) ?? onRoute;
      if (!fix) throw badInput(`Unknown fix ${name}`);
      points.push({ name: fix.name, pos: { ...fix.pos } });
    }
    cancelNavigation(ac);
    ac.cct = null;
    ac.fixList = points;
    if (!points.length) ac.assigned.heading = Math.round(ac.heading) || 360;
    return { act: "DCT", value: points.length ? points.map((p) => p.name).join(" ") : "CANCELLED" };
  }
  if (body.appr !== undefined) {
    const end = findRunwayEnd(body.appr);
    if (!end) throw badInput(`Unknown runway ${body.appr}`);
    const course = appr(end).course;
    if (Math.abs(angleDiff(effectiveHeading(ac), course)) > config.sim.approachCaptureMaxDeg)
      throw reject(`More than ${config.sim.approachCaptureMaxDeg}° off the ${end.name} final course`);
    clearApproach(ac, end.name);
    return { act: "APPR", value: end.name };
  }
  throw badInput("Send exactly one of alt, hdg, spd, dct, appr, emer, del");
}

export function gndControl(ac: Aircraft, body: GndBody, ctx: SimContext): ControlResult {
  if (!ac.onGround || !ac.gnd) throw reject("Aircraft is not on the ground");
  if (!config.features.ground) throw reject("Ground movement is disabled");
  let status: string;
  switch (body.action) {
    case "push":
      status = pushback(ac, ctx, { facing: body.facing, to: body.to });
      break;
    case "taxi":
      status = startTaxi(ac, ctx, { route: body.route, nodes: body.nodes ?? [], target: body.target });
      break;
    case "stop":
      status = holdPosition(ac);
      break;
    case "cont":
      status = continueTaxi(ac);
      break;
    case "tkof":
      status = takeoff(ac, ctx, { runway: body.runway, altitude: body.altitude, wait: body.wait });
      break;
    case "follow":
      status = follow(ac, ctx, { leader: body.leader, until: body.until });
      break;
  }
  return { act: "GND", value: status };
}

export function twrControl(ac: Aircraft, body: TwrBody, ctx: SimContext): ControlResult {
  switch (body.action) {
    case "land": {
      if (ac.onGround) throw reject("Aircraft is on the ground");
      const rwy = ac.cct?.rwy ?? ac.approach;
      if (!rwy) throw reject("Clear it for an approach first");
      ac.landClr = !ac.landClr;
      const msg = !ac.landClr
        ? `LANDING CLEARANCE CANCELLED ${ac.callsign} ${rwy}`
        : ac.cct?.tng
          ? `CLEARED TOUCH AND GO ${ac.callsign} ${rwy}`
          : `CLEARED TO LAND ${ac.callsign} ${rwy}`;
      ctx.log(msg);
      return { act: "TWR", value: ac.landClr ? (ac.cct?.tng ? "CLEARED TOUCH AND GO" : "CLEARED TO LAND") : "LANDING CLEARANCE CANCELLED" };
    }
    case "ga": {
      if (ac.onGround) throw reject("Aircraft is on the ground");
      if (!ac.approach && !ac.cct) throw reject("Clear it for an approach first");
      goAround(ac, ctx, "instructed");
      return { act: "TWR", value: "GO AROUND" };
    }
    case "cct": {
      const c = makeCircuit(ac, body.runway, { side: body.side, tng: body.tng, join: body.join });
      const sideText = c.side === "L" ? "left" : "right";
      const joinText = { DW: "join downwind", DOWN: "join downwind direct", BASE: "join base", UP: "join upwind", CROSS: "join crosswind" }[body.join];
      if (ac.onGround) {
        ac.cctAfterTakeoff = { rwy: c.rwy, side: c.side, tng: c.tng };
        ctx.log(`CIRCUIT ${ac.callsign} ${c.rwy} ${sideText} after departure`);
      } else {
        cancelNavigation(ac);
        ac.cct = c;
        ac.landClr = false;
        ctx.log(`CIRCUIT ${ac.callsign} ${c.rwy} ${sideText}, ${joinText}`);
      }
      return { act: "CCT", value: `${c.rwy} ${c.side} ${c.tng ? "TG" : "FS"} ${body.join}` };
    }
    case "tng": {
      const c = ac.cct ?? ac.cctAfterTakeoff;
      if (!c) throw reject("Not in the circuit");
      c.tng = !c.tng;
      return { act: "CCT", value: c.tng ? "TOUCH AND GO" : "FULL STOP" };
    }
    case "ext":
      return { act: "CCT", value: extendOrTurn(ac, ctx) };
    case "xcct": {
      if (!ac.cct && !ac.cctAfterTakeoff) throw reject("Not in the circuit");
      ac.cct = null;
      ac.cctAfterTakeoff = null;
      ac.landClr = false;
      ac.assigned.heading = Math.round(ac.heading) || 360;
      ctx.log(`${ac.callsign} left the circuit`);
      return { act: "CCT", value: "LEFT THE CIRCUIT" };
    }
    case "hold": {
      const h = startHold(ac, { fix: body.fix, course: body.course, turn: body.turn, leg: body.leg, alt: body.alt, spd: body.spd });
      return { act: "HOLD", value: `${h.fix} ${heading3(h.crs)} ${h.dir} ${h.leg}s` };
    }
    case "xhold":
      leaveHold(ac);
      return { act: "HOLD", value: "LEAVE HOLD" };
  }
}
