// In-memory session registry and the wall-clock tick loop (spec 5.1).
import crypto from "node:crypto";
import { config } from "@sweatbox/config";
import type { SessionStats } from "@sweatbox/shared";
import { Session } from "../sim/session";
import type { Store } from "../db";
import { HttpError } from "../errors";

const SC = config.session;

type TickListener = (s: Session) => void;
type EndListener = (s: Session, stats: SessionStats) => void;
type GoneListener = (code: string) => void;

export class SessionManager {
  readonly sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout | null = null;
  private onTickFns: TickListener[] = [];
  private onEndFns: EndListener[] = [];
  private onGoneFns: GoneListener[] = [];

  constructor(private store: Store) {}

  onTick(fn: TickListener): void {
    this.onTickFns.push(fn);
  }
  onEnd(fn: EndListener): void {
    this.onEndFns.push(fn);
  }
  onGone(fn: GoneListener): void {
    this.onGoneFns.push(fn);
  }

  private newCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < SC.codeLength; i++) code += SC.codeAlphabet[crypto.randomInt(SC.codeAlphabet.length)];
      // an archived replay keeps its code (academy results link to it)
      if (!this.sessions.has(code) && !this.store.replayExists(code)) return code;
    }
  }

  create(hostId: string): Session {
    if (this.sessions.size >= SC.maxSessions) throw new HttpError(429, "RATE_LIMITED", "The server is full: too many sessions running");
    const s = new Session(this.newCode(), hostId);
    this.sessions.set(s.code, s);
    return s;
  }

  get(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  end(s: Session): SessionStats {
    const already = s.ended;
    const stats = s.end();
    if (!already) {
      const retentionMs = s.academyId
        ? config.academy.replayRetentionDays * 86_400_000
        : SC.archiveLongRetention
          ? SC.archiveLongRetentionDays * 86_400_000
          : SC.endedRetentionSec * 1000;
      try {
        this.store.archiveReplay(s.code, s.endedAt!, s.endedAt! + retentionMs, JSON.stringify(s.replay()));
      } catch (e) {
        console.error(`replay archive failed for ${s.code}: ${(e as Error).message}`);
      }
      for (const fn of this.onEndFns) fn(s, stats);
    }
    return stats;
  }

  remove(code: string): void {
    if (!this.sessions.delete(code)) return;
    for (const fn of this.onGoneFns) fn(code);
  }

  /** One wall-clock tick for every session, then broadcast and expire. */
  tickAll(now = Date.now()): void {
    for (const s of [...this.sessions.values()]) {
      try {
        s.wallTick(now);
      } catch (e) {
        console.error(`session ${s.code} tick failed`, e);
        s.log(`Internal error: ${(e as Error).message}`, "error");
        s.pause();
      }
      for (const fn of this.onTickFns) fn(s);
      if (!s.ended && now - s.lastActivity > SC.idleTimeoutSec * 1000) this.remove(s.code);
      else if (s.ended && s.endedAt !== null && now - s.endedAt > SC.endedRetentionSec * 1000) this.remove(s.code);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tickAll(), SC.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
