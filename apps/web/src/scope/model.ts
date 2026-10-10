// Normalised aircraft for drawing: session snapshots and replay frames both become this.
import cfg from "@sweatbox/config/public";
import { wakeOf, type AircraftDTO, type FlightPlanDTO, type ReplayAircraft, type Strips } from "@sweatbox/shared";

export type ViewMode = "CTR" | "GND" | "TWR";

export interface RAircraft {
  id: string;
  callsign: string;
  type: string;
  wake: string;
  x: number;
  y: number;
  heading: number;
  altitude: number;
  gs: number;
  vs: number;
  trail: [number, number][];
  onGround: boolean;
  emergency: boolean;
  dep: string | null;
  arr: string | null;
  /** Full session data (host bar, ground status, routes). */
  dto?: AircraftDTO;
  fp?: FlightPlanDTO;
}

export function fromSession(list: AircraftDTO[], fps: FlightPlanDTO[], strips: Strips): RAircraft[] {
  const byId = new Map(fps.map((f) => [f.aircraftId, f]));
  return list.map((a) => {
    const fp = byId.get(a.id);
    const strip = strips[a.callsign];
    return {
      id: a.id,
      callsign: a.callsign,
      type: strip?.o_atyp || a.type,
      wake: a.wake,
      x: a.x,
      y: a.y,
      heading: a.heading,
      altitude: a.altitude,
      gs: a.groundSpeed,
      vs: a.verticalSpeed,
      trail: a.trail,
      onGround: a.onGround,
      emergency: a.emergency,
      dep: fp?.departing ?? null,
      arr: strip?.o_ades || fp?.arriving || null,
      dto: a,
      fp,
    };
  });
}

export function fromReplay(frame: ReplayAircraft[], history: Map<string, [number, number][]>, plans: Map<string, { dep: string | null; arr: string | null }>, prevAlt: Map<string, number>): RAircraft[] {
  return frame.map(([callsign, type, x, y, altitude, gs, heading, emer]) => {
    const plan = plans.get(callsign);
    const before = prevAlt.get(callsign);
    return {
      id: callsign,
      callsign,
      type,
      wake: wakeOf(type),
      x,
      y,
      heading,
      altitude,
      gs,
      vs: before === undefined ? 0 : (altitude - before) * 60,
      trail: history.get(callsign) ?? [],
      onGround: altitude <= 0 && gs < 60,
      emergency: emer === 1,
      dep: plan?.dep ?? null,
      arr: plan?.arr ?? null,
    };
  });
}

/** Traffic colour by role relative to the loaded airport. */
export function trafficColour(a: RAircraft, apt: string | null): string {
  const c = cfg.colours;
  if (a.dep && a.dep === a.arr) return c.local;
  if (apt && a.dep === apt) return c.departure;
  if (apt && a.arr === apt) return c.arrival;
  return c.other;
}
