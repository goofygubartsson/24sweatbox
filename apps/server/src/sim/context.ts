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

/** The [sweatbox] runway settings (RWYCFG): departure runway, then the arrival runways. */
export interface RunwayConfig {
  apt: string;
  dep: string;
  arr: string[];
}

/** What the sim modules need from a session (keeps them free of the Session class). */
export interface SimContext {
  readonly simTotal: number;
  /** The session's airport (LDARPT), if the file names one. */
  readonly airport: string | null;
  readonly runwayConfig: RunwayConfig | null;
  readonly twrMode: boolean;
  readonly rolloutMode: "OFF" | "HOLD" | "STAND";
  readonly aircraft: Aircraft[];
  readonly strips: Strips;
  readonly counters: Counters;
  /** Sim time of the last takeoff per runway pair ("IRFD 07R/25L"). */
  readonly lastTakeoff: Record<string, number>;
  log(message: string, level?: LogLevel): void;
  byId(id: string): Aircraft | undefined;
  byCallsign(cs: string): Aircraft | undefined;
  /** Random number in [0, 1) (seedable in tests). */
  random(): number;
}
