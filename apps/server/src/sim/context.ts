import type { LogLevel, Strips } from "@sweatbox/shared";
import type { Aircraft } from "./types";

export interface Counters {
  spawned: number;
  landed: number;
  arrived: number;
  deleted: number;
  emergencies: number;
  separationLosses: number;
  peakTraffic: number;
  scriptCommandsRun: number;
  hostCmds: Record<string, number>;
}

/** What the sim modules need from a session (keeps them free of the Session class). */
export interface SimContext {
  readonly simTotal: number;
  /** The session's airport (LDARPT), if the file names one. */
  readonly airport: string | null;
  readonly twrMode: boolean;
  readonly rolloutMode: "OFF" | "HOLD" | "STAND";
  readonly aircraft: Aircraft[];
  readonly strips: Strips;
  readonly counters: Counters;
  log(message: string, level?: LogLevel): void;
  byId(id: string): Aircraft | undefined;
  byCallsign(cs: string): Aircraft | undefined;
  /** Random number in [0, 1) (seedable in tests). */
  random(): number;
}
