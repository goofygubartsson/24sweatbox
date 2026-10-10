import type { CircuitLeg, FlightPlanDTO, GroundMode, JoinLeg, PushOption, Vec, Wake } from "@sweatbox/shared";

export interface FixPoint {
  name: string;
  pos: Vec;
}

export interface CircuitState {
  /** Runway end, "IRFD-25C". */
  rwy: string;
  side: "L" | "R";
  leg: CircuitLeg;
  /** Touch-and-go (true) or full stop. */
  tng: boolean;
  alt: number;
  spd: number;
  /** Rotation speed for takeoffs in the circuit. */
  vr: number;
  /** Current leg extended. */
  ext: boolean;
  /** Pattern anchors in the runway frame (map units): s along the landing direction from the
   * threshold, l sideways toward the pattern. */
  sUp: number;
  lDown: number;
  sBase: number;
  /** DW join: still flying to the downwind entry point. */
  joining: boolean;
}

export interface HoldState {
  fix: string;
  pos: Vec;
  /** Inbound course. */
  crs: number;
  dir: "L" | "R";
  leg: number;
  ph: "entry" | "out" | "in" | "turn";
  /** Turn target while ph = "turn" (heading) and what comes after. */
  turnTo: number;
  next: "out" | "in";
  /** Seconds flown on the outbound leg. */
  t: number;
  /** Route to resume after the hold (fixes after the hold fix). */
  resume: FixPoint[];
}

export interface DepartureState {
  /** Departure runway end. */
  rwy: string;
  route: string;
  joined: boolean;
  /** The host turned it, gave a direct, an approach, a hold or a circuit: never join the route. */
  overridden: boolean;
}

export interface LandingState {
  phase: "flare";
  rwy: string;
}

export interface PathPoint {
  p: Vec;
  /** Graph node at this point, if any. */
  n: number | null;
}

export type TaxiTarget = { kind: "hold"; name: string } | { kind: "stand"; name: string } | { kind: "short"; twy: string } | { kind: "end" } | { kind: "node"; n: number };

export interface TaxiRequest {
  route: string[];
  nodes: number[];
  target: string;
}

/**
 * An automatic departure (script AUTO). Without CLR it pushes and taxis to a holding point for the
 * runway, then waits for the controller. With CLR (DEL sweatboxes) it first waits for the strip
 * clearance, then also crosses runways, lines up and takes off by itself.
 */
export interface AutoState {
  /** Departure runway end, "IRFD-25R". */
  rwy: string;
  /** The runway it was given; `rwy` moves to the next runway set when this one's queue is full. */
  primary: string;
  /** Cleared aircraft run the whole departure by themselves (AUTO ... CLR). */
  full: boolean;
  phase: "clearance" | "push" | "taxi" | "depart" | "lined";
  /** Holding point it is taxiing to. */
  hold: string | null;
  /** Sim time of the next check while waiting. */
  nextCheck: number;
}

export interface GroundState {
  apt: string;
  mode: GroundMode;
  /** Status shown to the host. */
  status: string;
  /** Status before "HOLD POSITION". */
  statusBeforeStop: string | null;
  /** Stand the aircraft is on (or heading for). */
  stand: string | null;
  /** Remaining path; path[0] is the next point to reach. */
  path: PathPoint[];
  /** Last graph node passed / stopped at. */
  node: number | null;
  /** Edge the aircraft sits on facing away from (no U-turn onto it). */
  noUturnEdge: number | null;
  reverse: boolean;
  endHeading: number | null;
  /** Taxi instruction queued during pushback. */
  queued: TaxiRequest | null;
  pushFacing: PushOption[];
  /** What happens at the end of the current path. */
  target: TaxiTarget | null;
  /** Runway end for lineup / takeoff, "IRFD-25L". */
  rwy: string | null;
  climb: number;
  wait: boolean;
  spacing: boolean;
  paused: boolean;
  follow: { leaderId: string; until: string | null; recalcAt: number } | null;
  /** Sim tick when parked on a stand (arrivals are removed after standRemoveAfterSec). */
  parkedSince: number | null;
  arrival: boolean;
  /** Rollout: remaining path length at the runway exit (runway deceleration applies before it). */
  rolloutExitAt: number | null;
  /** Holding points ahead where the aircraft must stop before crossing a runway (until CONT). */
  crossStops: { node: number; rwy: string }[];
  /** Automatic departure, if any. */
  auto: AutoState | null;
}

export interface Aircraft {
  id: string;
  callsign: string;
  type: string;
  wake: Wake;
  pos: Vec;
  heading: number;
  altitude: number;
  groundSpeed: number;
  verticalSpeed: number;
  trail: Vec[];
  onGround: boolean;
  emergency: boolean;
  emergencyCounted: boolean;
  assigned: { alt: number; heading: number; speed: number };
  fixList: FixPoint[];
  /** Cleared approach runway end. */
  approach: string | null;
  apprCaptured: boolean;
  landClr: boolean;
  cct: CircuitState | null;
  /** Circuit to start after takeoff (set while on the ground). */
  cctAfterTakeoff: { rwy: string; side?: "L" | "R"; tng: boolean } | null;
  hold: HoldState | null;
  dep: DepartureState | null;
  /** Fly to the destination when there is nothing else to do (removed within arrivalRemoveNm). */
  homing: boolean;
  /**
   * A departure to another airport: after its route it flies to a point on a final there (`rwy`,
   * chosen at the end of the route), lands and is removed.
   */
  autoLand: { rwy: string | null } | null;
  /**
   * Flying on its own after a ground departure (sim time of the lift-off, which also orders who
   * gives way); null once a controller instructs it. Such aircraft keep separation by themselves.
   */
  autoFlight: number | null;
  /** Temporary limits from the automatic separation (on top of the assigned altitude and speed). */
  sepLimit: SepLimit | null;
  arr: string | null;
  gnd: GroundState | null;
  landing: LandingState | null;
  fp: Omit<FlightPlanDTO, "aircraftId">;
  /** For the vertical speed window. */
  vsRef: { alt: number; sim: number };
  /** Last script ALT/SPD/HDG (mirrored into everyone's tags). */
  scriptTag: { alt?: number; heading?: number; speed?: number; seq: number } | null;
  /** Removed at the end of the tick. */
  gone: boolean;
}

export interface SepLimit {
  altMax?: number;
  altMin?: number;
  speedMax?: number;
  /** No level keeps it clear of those it gives way to: they give way to it as well. */
  stuck?: boolean;
}

export type { JoinLeg };
