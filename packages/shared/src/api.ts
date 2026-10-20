// The REST + WebSocket contract (spec section 15). Request bodies are zod schemas (the server
// validates every body with them); responses are plain types. Both apps import this file.
import { z } from "zod";
import type { Wake } from "./dataTypes";

// ---- errors ------------------------------------------------------------------------------------------

export type ErrorCode =
  | "BAD_INPUT"
  | "NOT_LOGGED_IN"
  | "NOT_HOST"
  | "NOT_IN_GUILD"
  | "NO_SESSION"
  | "NO_AIRCRAFT"
  | "NO_SCENARIO"
  | "REJECTED"
  | "SCRIPT_ERRORS"
  | "RATE_LIMITED"
  | "FEATURE_DISABLED"
  | "WRONG_ACCOUNT"
  | "LINK_CLOSED"
  | "SERVER_ERROR";

export interface ApiError {
  error: string;
  code: ErrorCode;
  details?: unknown;
  errors?: string[];
  /** ATC24Academy launch links that can't be used: where to send the student back. */
  returnUrl?: string;
}

// ---- auth --------------------------------------------------------------------------------------------

export interface Me {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isHost: boolean;
  reauth: boolean;
}

export const DevLoginBody = z.object({
  as: z.enum(["host", "viewer"]),
  name: z.string().trim().min(1).max(32).default("Dev"),
});
export type DevLoginBody = z.infer<typeof DevLoginBody>;

// ---- sessions ----------------------------------------------------------------------------------------

export const SESSION_CODE_RE = /^[A-Za-z]{6}$/;

export interface SessionInfo {
  code: string;
  hostId: string;
  scriptName: string | null;
  running: boolean;
  speed: number;
  elapsedSec: number;
  ended: boolean;
  /** The ATC24Academy assessment this session runs, if any. */
  academyId: string | null;
}

export interface ScenarioInfo {
  name: string;
  pos: string | null;
  apt: string | null;
  rwy: string | null;
}

/** Airport + Position + Runway format: the server generates a ready-to-load sweatbox from these. */
export const GenerateSpec = z
  .object({
    apt: z.string().trim().toUpperCase().regex(/^I[A-Z0-9]{3}$/, "Pick an airport"),
    position: z.enum(["DEL", "GND", "TWR", "APP", "CTR"]),
    runway: z.string().trim().regex(/^\d{2}$/, "Pick a runway format"),
    level: z.enum(["light", "normal", "heavy"]).optional(),
  })
  .strict();
export type GenerateSpec = z.infer<typeof GenerateSpec>;

export const CreateSessionBody = z.object({ generate: GenerateSpec.optional() }).strict();
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const ScriptBody = z.union([
  z.object({ name: z.string().regex(/^[A-Za-z0-9-]+$/, "Scenario names are letters, digits and dashes").max(64) }).strict(),
  z.object({ text: z.string().min(1), label: z.string().trim().max(64).optional() }).strict(),
  z.object({ generate: GenerateSpec }).strict(),
]);
export type ScriptBody = z.infer<typeof ScriptBody>;

export const ClockBody = z.union([
  z.object({ action: z.enum(["play", "pause"]) }).strict(),
  z.object({ speed: z.number().finite() }).strict(),
]);
export type ClockBody = z.infer<typeof ClockBody>;

export const TwrToggleBody = z.object({ on: z.boolean() }).strict();

// ---- host aircraft control ---------------------------------------------------------------------------

const exactlyOne = <T extends Record<string, unknown>>(o: T) => Object.values(o).filter((v) => v !== undefined).length === 1;

export const AirBody = z
  .object({
    alt: z.number().int().min(0).max(99999).optional(),
    hdg: z.number().int().min(1).max(360).optional(),
    spd: z.number().int().min(1).max(2000).optional(),
    dct: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,7}$/)).max(50).optional(),
    appr: z.string().trim().toUpperCase().regex(/^I[A-Z0-9]{3}-\d{2}[LCR]?$/).optional(),
    emer: z.literal(true).optional(),
    del: z.literal(true).optional(),
  })
  .strict()
  .refine(exactlyOne, "Send exactly one of alt, hdg, spd, dct, appr, emer, del");
export type AirBody = z.infer<typeof AirBody>;

const NodeIndex = z.number().int().nonnegative();
const RunwayName = z.string().trim().toUpperCase().regex(/^I[A-Z0-9]{3}-\d{2}[LCR]?$/);

export const GndBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("push"), facing: z.number().int().min(0).max(360).optional(), to: NodeIndex.optional() }).strict(),
  z
    .object({
      action: z.literal("taxi"),
      route: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9/]{1,8}$/, "Bad route")).max(20).default([]),
      nodes: z.array(NodeIndex).max(20).optional(),
      target: z
        .string()
        .trim()
        .regex(/^$|^[HST]:[A-Za-z0-9/ -]{1,16}$|^N:\d{1,5}$/, "Target is H:<hold>, S:<stand>, T:<taxiway>, N:<node> or empty")
        .default(""),
    })
    .strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z.object({ action: z.literal("cont") }).strict(),
  z
    .object({
      action: z.literal("tkof"),
      runway: RunwayName,
      altitude: z.number().int().min(0).max(99999).optional(),
      wait: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("follow"),
      leader: z.string().uuid().optional(),
      until: z.string().regex(/^(N:\d+|T:[A-Za-z0-9/]{1,8})$/, "Bad follow limit").optional(),
    })
    .strict(),
]);
export type GndBody = z.infer<typeof GndBody>;

export const CircuitJoin = z.enum(["DW", "BASE", "UP", "CROSS", "DOWN"]);

export const TwrBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("land") }).strict(),
  z.object({ action: z.literal("ga") }).strict(),
  z
    .object({
      action: z.literal("cct"),
      runway: RunwayName,
      side: z.enum(["L", "R"]).optional(),
      tng: z.boolean().default(true),
      join: CircuitJoin.default("DW"),
    })
    .strict(),
  z.object({ action: z.literal("tng") }).strict(),
  z.object({ action: z.literal("ext") }).strict(),
  z.object({ action: z.literal("xcct") }).strict(),
  z
    .object({
      action: z.literal("hold"),
      fix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,7}$/).optional(),
      course: z.number().int().min(1).max(360).optional(),
      turn: z.enum(["L", "R"]).optional(),
      leg: z.number().int().min(20).max(600).optional(),
      alt: z.number().int().min(0).max(99999).optional(),
      spd: z.number().int().min(60).max(450).optional(),
    })
    .strict(),
  z.object({ action: z.literal("xhold") }).strict(),
]);
export type TwrBody = z.infer<typeof TwrBody>;

// ---- strips ------------------------------------------------------------------------------------------

export const STRIP_KEYS = ["o_ades", "o_atyp", "o_clmb", "o_sid", "o_stand", "rmk", "del", "c", "stand", "clmb"] as const;

export const StripBody = z
  .object({
    callsign: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{2,12}$/, "Bad callsign")),
    key: z.string().regex(/^(o_[a-z]{1,6}|rmk|del|c|stand|clmb)$/, "Bad strip key"),
    value: z.string().max(500),
  })
  .strict();
export type StripBody = z.infer<typeof StripBody>;

export type Strips = Record<string, Record<string, string>>;

// ---- DTOs --------------------------------------------------------------------------------------------

export type GroundMode = "stand" | "push" | "taxi" | "follow" | "holding" | "lineup" | "lined" | "takeoff" | "rollout";
export type CircuitLeg = "up" | "cross" | "down" | "base" | "final";
export type LogLevel = "info" | "warn" | "error" | "comment" | "host" | "cmd";

export interface CircuitDTO {
  rwy: string;
  side: "L" | "R";
  leg: CircuitLeg;
  tng: boolean;
  ext: boolean;
}

export interface HoldDTO {
  fix: string;
  crs: number;
  dir: "L" | "R";
  leg: number;
  ph: "entry" | "out" | "in" | "turn";
}

export interface GroundDTO {
  apt: string;
  mode: GroundMode;
  status: string;
  stand: string | null;
  /** Remaining planned path, hosts only. */
  path?: [number, number][];
  pushFacing: { hdg: number; twy: string }[];
  rwy: string | null;
  climb: number;
  spacing: boolean;
  paused: boolean;
}

export interface AircraftDTO {
  id: string;
  callsign: string;
  type: string;
  wake: Wake;
  x: number;
  y: number;
  heading: number;
  altitude: number;
  groundSpeed: number;
  verticalSpeed: number;
  trail: [number, number][];
  onGround: boolean;
  emergency: boolean;
  assigned: { alt: number; heading: number; speed: number };
  fixList: string[];
  /** Positions of fixList (waypoints generated after a SID have no fix-table entry). */
  fixPts: [number, number][];
  approach: string | null;
  landClr: boolean;
  cct: CircuitDTO | null;
  hold: HoldDTO | null;
  gnd: GroundDTO | null;
  /** Last script ALT/SPD/HDG for this aircraft; clients copy it into their tag notes when seq changes. */
  scriptTag: { alt?: number; heading?: number; speed?: number; seq: number } | null;
}

export interface FlightPlanDTO {
  aircraftId: string;
  callsign: string;
  aircraft: string;
  flightRules: "IFR" | "VFR";
  departing: string;
  arriving: string;
  route: string;
  flightLevel: string;
  sid?: string | null;
}

export interface LogEntryDTO {
  seq: number;
  atSec: number;
  message: string;
  level: LogLevel;
}

export interface CmdDTO {
  id: number;
  text: string;
}

export interface ClientDTO {
  name: string;
  user: string;
  host: boolean;
  connectedSec: number;
}

export interface SessionStats {
  code: string;
  scriptName: string | null;
  startedAt: number;
  endedAt: number;
  wallSec: number;
  simSec: number;
  spawned: number;
  landed: number;
  arrived: number;
  deleted: number;
  remaining: number;
  peakTraffic: number;
  emergencies: number;
  separationLosses: number;
  hostInstructions: number;
  hostBreakdown: Record<string, number>;
  scriptCommandsRun: number;
  scriptCommandsLeft: number;
}

export interface Snapshot {
  t: "snapshot";
  code: string;
  running: boolean;
  speed: number;
  elapsedSec: number;
  simTotal: number;
  scriptName: string | null;
  commandsRemaining: number;
  twr: boolean;
  rollout: "OFF" | "HOLD" | "STAND";
  ended: boolean;
  stats: SessionStats | null;
  aircraft: AircraftDTO[];
  flightPlans: FlightPlanDTO[];
  strips: Strips;
  log: LogEntryDTO[];
  cmds: CmdDTO[];
  clients?: ClientDTO[];
  /** The ATC24Academy assessment this session runs, if any. */
  academyId: string | null;
}

// ---- ATC24Academy assessments (the web side; the academy's own API is apps/server/src/academy) ------

export type AcademyStatus = "reserved" | "completed" | "cancelled";

/** An academy-booked session as the host or its student sees it. */
export interface AcademyView {
  id: string;
  status: AcademyStatus;
  /** Code of the running sweatbox session, when the host has started one. */
  liveCode: string | null;
  scheduledAt: string;
  course: string;
  module: string;
  assessmentType: string | null;
  instructions: string;
  passingCriteria: string;
  student: string;
  host: string | null;
  returnUrl: string;
  outcome: "pass" | "fail" | null;
  /** Host view only. */
  hostDiscordId?: string;
  inviteStatus?: "sent" | "pending" | "failed";
  inviteError?: string | null;
  /** Host view only: delivery of the result to the academy. */
  resultDelivery?: "pending" | "delivered" | "failed" | null;
}

export interface AcademyLaunchResult {
  view: AcademyView;
}

export const AcademyLaunchBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, "That launch link is broken") }).strict();

export const AcademyCompleteBody = z
  .object({
    outcome: z.enum(["pass", "fail"]),
    score: z.number().int().min(0).max(100).nullable().optional(),
    feedback: z.string().trim().max(5000).nullable().optional(),
  })
  .strict();
export type AcademyCompleteBody = z.infer<typeof AcademyCompleteBody>;

// ---- WebSocket ---------------------------------------------------------------------------------------

export const WsClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("join"), code: z.string().regex(SESSION_CODE_RE) }),
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("cmdAck"), id: z.number().int() }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

export type WsServerMessage =
  | Snapshot
  | { t: "ended"; stats: SessionStats }
  | { t: "gone" }
  | { t: "error"; error: string; code: ErrorCode };

/** WS close code when joining a session that does not exist. */
export const WS_CLOSE_NO_SESSION = 4404;
export const WS_CLOSE_NOT_LOGGED_IN = 4401;

// ---- replay ------------------------------------------------------------------------------------------

export const REPLAY_FORMAT = "atc24academy-sweatbox-replay";
export const REPLAY_FRAME_FIELDS = ["callsign", "type", "x", "y", "altitude", "groundSpeed", "heading", "emergency"] as const;

/** [callsign, type, x, y, altitude, groundSpeed, heading, emergency(0|1)] */
export type ReplayAircraft = [string, string, number, number, number, number, number, number];

export interface ReplayEvent {
  t: number;
  atSec: number;
  wall: number;
  message: string;
  level: LogLevel;
}

export interface ReplayFrame {
  t: number;
  e: number;
  a: ReplayAircraft[];
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  version: 1;
  code: string;
  scriptName: string | null;
  exportedAt: number;
  stats: SessionStats | Record<string, unknown> | null;
  frameFields: string[];
  events: ReplayEvent[];
  frames: ReplayFrame[];
}

export const ReplayFileSchema = z.object({
  format: z.literal(REPLAY_FORMAT),
  version: z.literal(1),
  code: z.string(),
  scriptName: z.string().nullable(),
  exportedAt: z.number(),
  stats: z.record(z.unknown()).nullable(),
  frameFields: z.array(z.string()),
  events: z.array(
    z.object({ t: z.number(), atSec: z.number(), wall: z.number(), message: z.string(), level: z.string() }).passthrough(),
  ),
  frames: z.array(z.object({ t: z.number(), e: z.number(), a: z.array(z.array(z.union([z.string(), z.number()]))) })),
});
