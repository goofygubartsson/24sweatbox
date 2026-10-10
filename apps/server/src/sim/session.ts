// One sweatbox session: authoritative simulation state, the tick (spec 5.1), script execution,
// log, replay recording, stats and snapshots.
import { config } from "@sweatbox/config";
import {
  dist,
  getGroundGraph,
  parseScript,
  REPLAY_FORMAT,
  REPLAY_FRAME_FIELDS,
  round,
  type AircraftDTO,
  type AirBody,
  type ClientDTO,
  type CmdDTO,
  type FlightPlanDTO,
  type GndBody,
  type LogEntryDTO,
  type LogLevel,
  type ReplayEvent,
  type ReplayFile,
  type ReplayFrame,
  type ScriptCommand,
  type SessionStats,
  type Snapshot,
  type Strips,
  type TwrBody,
} from "@sweatbox/shared";
import type { Aircraft } from "./types";
import type { Counters, RunwayConfig, SimContext } from "./context";
import { stepAirborne } from "./air";
import { autoTaxi, plannedPath, stepGround } from "./ground";
import { landingCheck, stepFlare, twrCheck } from "./landing";
import { arrivalCheck, departureJoin, spawnAirborne, spawnAtGate, spawnDeparture } from "./spawn";
import { airControl, clearApproach, gndControl, toggleEmergency, twrControl, type ControlResult } from "./control";
import { makeCircuit } from "./circuit";
import { autoSeparation, separationExempt } from "./separation";
import { HttpError, notFound } from "../errors";

const SC = config.session;
const SIM = config.sim;

type GateCommand = Extract<ScriptCommand, { kind: "GATE" }>;

export interface ClientInfo {
  userId: string;
  name: string;
  user: string;
  host: boolean;
  firstSeen: number;
  lastSeen: number;
}

/** Per-viewer delivery state for snapshots. */
export interface Viewer {
  host: boolean;
  lastLogSeq: number;
  lastCmdId: number;
}

const zeroCounters = (): Counters => ({
  spawned: 0,
  landed: 0,
  arrived: 0,
  deleted: 0,
  emergencies: 0,
  separationLosses: 0,
  peakTraffic: 0,
  scriptCommandsRun: 0,
  hostCmds: {},
});

export class Session implements SimContext {
  readonly createdAt = Date.now();
  running = false;
  speed = 1;
  elapsedSec = 0;
  simTotal = 0;
  script: ScriptCommand[] = [];
  scriptName: string | null = null;
  aircraft: Aircraft[] = [];
  strips: Strips = {};
  lastTakeoff: Record<string, number> = {};
  logEntries: (LogEntryDTO & { wall: number })[] = [];
  logSeq = 0;
  events: ReplayEvent[] = [];
  frames: ReplayFrame[] = [];
  counters: Counters = zeroCounters();
  twrMode = false;
  rolloutMode: "OFF" | "HOLD" | "STAND" = "OFF";
  runwayConfig: RunwayConfig | null = null;
  airport: string | null = null;
  ended = false;
  endedAt: number | null = null;
  finalStats: SessionStats | null = null;
  clients = new Map<string, ClientInfo>();
  cmds: CmdDTO[] = [];
  cmdSeq = 0;
  lastActivity = Date.now();
  startedAt: number | null = null;
  private sepActive = new Set<string>();
  /** GATE lines waiting for their stand (or any free stand for "*"), with that callsign's later lines. */
  private pendingGates: { cmd: GateCommand; held: { cmd: ScriptCommand; delta: number }[] }[] = [];
  /** Held lines of a late spawn, run at their original distance from the GATE line. */
  private delayed: { at: number; cmd: ScriptCommand }[] = [];
  /** Sim time each stand became free ("IRFD 5"), for refilling "*" stands after standRefillSec. */
  private standFreeSince = new Map<string, number>();
  private lastVsWall = 0;
  private scriptTagSeq = 0;
  private rng: () => number;

  constructor(
    readonly code: string,
    readonly hostId: string,
    rng: () => number = Math.random,
  ) {
    this.rng = rng;
  }

  // ---- SimContext --------------------------------------------------------------------------------------

  log(message: string, level: LogLevel = "info"): void {
    const entry = { seq: ++this.logSeq, atSec: this.elapsedSec, message, level, wall: Date.now() };
    this.logEntries.push(entry);
    if (this.logEntries.length > SC.logLimit) this.logEntries.splice(0, this.logEntries.length - SC.logLimit);
    if (this.events.length < SC.replayMaxEvents)
      this.events.push({ t: this.simTotal, atSec: this.elapsedSec, wall: entry.wall, message, level });
  }

  byId(id: string): Aircraft | undefined {
    return this.aircraft.find((a) => a.id === id && !a.gone);
  }

  byCallsign(cs: string): Aircraft | undefined {
    const c = cs.toUpperCase();
    return this.aircraft.find((a) => a.callsign === c && !a.gone);
  }

  random(): number {
    return this.rng();
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  // ---- script & clock ----------------------------------------------------------------------------------

  /** Validate and load a script. Returns the errors (and loads nothing) when it doesn't parse. */
  loadScript(name: string, text: string): { ok: true; commandCount: number } | { ok: false; errors: string[] } {
    const parsed = parseScript(text);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    this.running = false;
    this.speed = 1;
    this.elapsedSec = 0;
    this.simTotal = 0;
    this.script = parsed.commands;
    this.scriptName = name;
    this.aircraft = [];
    this.strips = {};
    this.lastTakeoff = {};
    this.logEntries = [];
    this.events = [];
    this.frames = [];
    this.counters = zeroCounters();
    this.sepActive.clear();
    this.cmds = [];
    this.pendingGates = [];
    this.delayed = [];
    this.standFreeSince.clear();
    this.rolloutMode = "OFF";
    this.runwayConfig = null;
    this.airport = null;
    this.startedAt = null;
    this.log(`Loaded script "${name}" (${parsed.commands.length} commands)`);
    for (const w of parsed.warnings.slice(0, 20)) this.log(w, "warn");
    return { ok: true, commandCount: parsed.commands.length };
  }

  play(): void {
    if (this.ended) throw new HttpError(409, "REJECTED", "Session has ended");
    this.running = true;
    this.startedAt ??= Date.now();
  }

  pause(): void {
    this.running = false;
  }

  setSpeed(n: number): number {
    this.speed = Math.max(SC.minSpeed, Math.min(SC.maxSpeed, Math.round(n)));
    return this.speed;
  }

  setTwr(on: boolean): void {
    if (on === this.twrMode) return;
    this.twrMode = on;
    this.log(on ? "TWR open: arrivals need landing clearance" : "TWR closed: landing clearance no longer required");
  }

  // ---- the tick ----------------------------------------------------------------------------------------

  /** Called once per wall-clock tick: runs `speed` sim ticks when running, refreshes VS / trails. */
  wallTick(now = Date.now()): void {
    if (this.running && !this.ended) for (let i = 0; i < this.speed; i++) this.tick();
    if (now - this.lastVsWall >= SC.vsWindowSec * 1000) {
      this.lastVsWall = now;
      this.updateVsAndTrails();
    }
  }

  /** One simulated second. */
  tick(): void {
    this.simTotal++;
    this.elapsedSec++;
    // 2. script commands that are due
    while (this.script.length && this.script[0]!.offset <= this.elapsedSec) {
      const c = this.script.shift()!;
      this.counters.scriptCommandsRun++;
      try {
        this.execute(c);
      } catch (e) {
        this.log(`Line ${c.line}: ${(e as Error).message}`, "error");
      }
    }
    this.runPendingGates();
    // 3. landing check, then automatic separation for aircraft flying on their own
    for (const ac of this.aircraft) if (!ac.onGround && !ac.gone) landingCheck(ac, this);
    autoSeparation(this);
    // 4. movement, then the TWR clearance check
    for (const ac of this.aircraft) {
      if (ac.gone) continue;
      if (ac.onGround && ac.gnd) stepGround(ac, this);
      else if (ac.landing) stepFlare(ac, this);
      else if (!ac.onGround) stepAirborne(ac, this);
    }
    for (const ac of this.aircraft) twrCheck(ac, this);
    // 5. after-tick passes
    for (const ac of this.aircraft) {
      if (ac.gone) continue;
      departureJoin(ac, this);
      arrivalCheck(ac, this);
    }
    this.aircraft = this.aircraft.filter((a) => !a.gone);
    this.counters.peakTraffic = Math.max(this.counters.peakTraffic, this.aircraft.length);
    for (const ac of this.aircraft)
      if (ac.emergency && !ac.emergencyCounted) {
        ac.emergencyCounted = true;
        this.counters.emergencies++;
      }
    this.separationCheck();
    this.recordFrame();
  }

  private separationCheck(): void {
    const air = this.aircraft.filter((a) => !a.onGround);
    const active = new Set<string>();
    for (let i = 0; i < air.length; i++)
      for (let j = i + 1; j < air.length; j++) {
        const a = air[i]!;
        const b = air[j]!;
        const nm = dist(a.pos, b.pos) / SIM.unitsPerNm;
        const ft = Math.abs(a.altitude - b.altitude);
        if (nm >= SIM.sepLossNm || ft >= SIM.sepLossFt) continue;
        if (separationExempt(a, b)) continue;
        const key = [a.callsign, b.callsign].sort().join("/");
        active.add(key);
        if (!this.sepActive.has(key)) {
          this.counters.separationLosses++;
          this.log(`SEPARATION LOSS ${key} (${nm.toFixed(1)} NM, ${Math.round(ft)} ft)`, "warn");
        }
      }
    this.sepActive = active;
  }

  private recordFrame(): void {
    if (this.frames.length >= SC.replayMaxFrames) return;
    this.frames.push({
      t: this.simTotal,
      e: this.elapsedSec,
      a: this.aircraft.map((ac) => [
        ac.callsign,
        ac.type,
        round(ac.pos.x, 4),
        round(ac.pos.y, 4),
        Math.round(ac.altitude),
        Math.round(ac.groundSpeed),
        Math.round(ac.heading) % 360,
        ac.emergency ? 1 : 0,
      ]),
    });
  }

  private updateVsAndTrails(): void {
    for (const ac of this.aircraft) {
      const dt = this.simTotal - ac.vsRef.sim;
      if (dt <= 0) continue;
      ac.verticalSpeed = Math.round(((ac.altitude - ac.vsRef.alt) * 60) / dt);
      ac.vsRef = { alt: ac.altitude, sim: this.simTotal };
      ac.trail.unshift({ ...ac.pos });
      if (ac.trail.length > SC.trailPoints) ac.trail.length = SC.trailPoints;
    }
  }

  // ---- script commands ---------------------------------------------------------------------------------

  private add(ac: Aircraft | null): void {
    if (!ac) return;
    if (this.aircraft.length >= SC.maxAircraft) {
      this.log(`Too many aircraft (${SC.maxAircraft}): ${ac.callsign} not spawned`, "error");
      return;
    }
    ac.vsRef = { alt: ac.altitude, sim: this.simTotal };
    this.aircraft.push(ac);
    this.counters.spawned++;
  }

  private need(cs: string, kind: string): Aircraft | null {
    const ac = this.byCallsign(cs);
    if (!ac) this.log(`${kind}: unknown aircraft ${cs}`, "warn");
    return ac ?? null;
  }

  private setScriptTag(ac: Aircraft, patch: { alt?: number; heading?: number; speed?: number }): void {
    ac.scriptTag = { ...(ac.scriptTag ?? {}), ...patch, seq: ++this.scriptTagSeq };
  }

  /** Stand occupied by an aircraft, or with one standing on it (pushing, taxiing in). */
  private standTaken(apt: string, name: string, at: { x: number; y: number }): boolean {
    return this.aircraft.some(
      (o) => !o.gone && o.onGround && o.gnd?.apt === apt && (o.gnd.stand === name || dist(o.pos, at) < config.ground.standClearUnits),
    );
  }

  /** Try to park a GATE line now. False when its stand (or every stand, for "*") is taken. */
  private tryGate(c: GateCommand): boolean {
    const g = getGroundGraph(c.apt);
    if (!g) {
      this.add(spawnAtGate(c.cs, c.type, c, this)); // logs why it can't park
      return true;
    }
    let stand: string | null = null;
    if (c.stand === "*") {
      const ready = g.stands.filter(
        (st) => !this.standTaken(g.icao, st.name, g.nodes[st.n]!) && this.simTotal - (this.standFreeSince.get(`${g.icao} ${st.name}`) ?? 0) >= config.ground.standRefillSec,
      );
      // the stand that has been free longest
      ready.sort((a, b) => (this.standFreeSince.get(`${g.icao} ${a.name}`) ?? 0) - (this.standFreeSince.get(`${g.icao} ${b.name}`) ?? 0));
      stand = ready[0]?.name ?? null;
    } else {
      const st = g.standByName.get(c.stand.toUpperCase());
      if (!st) {
        this.add(spawnAtGate(c.cs, c.type, c, this)); // logs the unknown stand
        return true;
      }
      stand = this.standTaken(g.icao, st.name, g.nodes[st.n]!) ? null : st.name;
    }
    if (!stand) return false;
    this.add(spawnAtGate(c.cs, c.type, { ...c, stand }, this));
    return true;
  }

  /** Late spawns: refresh which stands are free, park waiting GATE lines, run their held lines. */
  private runPendingGates(): void {
    if (this.pendingGates.length) {
      for (const apt of new Set(this.pendingGates.map((p) => p.cmd.apt))) {
        const g = getGroundGraph(apt);
        if (!g) continue;
        for (const st of g.stands) {
          const key = `${g.icao} ${st.name}`;
          if (this.standTaken(g.icao, st.name, g.nodes[st.n]!)) this.standFreeSince.delete(key);
          else if (!this.standFreeSince.has(key)) this.standFreeSince.set(key, this.simTotal);
        }
      }
      const still: typeof this.pendingGates = [];
      for (const p of this.pendingGates) {
        if (this.byCallsign(p.cmd.cs) || !this.tryGate(p.cmd)) {
          still.push(p);
          continue;
        }
        for (const h of p.held) this.delayed.push({ at: this.elapsedSec + Math.max(0, h.delta), cmd: h.cmd });
      }
      this.pendingGates = still;
    }
    if (this.delayed.length) {
      const due = this.delayed.filter((d) => d.at <= this.elapsedSec);
      this.delayed = this.delayed.filter((d) => d.at > this.elapsedSec);
      for (const d of due) {
        try {
          this.execute(d.cmd);
        } catch (e) {
          this.log(`Line ${d.cmd.line}: ${(e as Error).message}`, "error");
        }
      }
    }
  }

  execute(c: ScriptCommand): void {
    // lines for an aircraft still waiting for a stand wait with it
    const waitingFor = "cs" in c ? this.pendingGates.find((p) => p.cmd.cs === c.cs) : undefined;
    if (waitingFor && c.kind !== "GATE") {
      waitingFor.held.push({ cmd: c, delta: c.offset - waitingFor.cmd.offset });
      return;
    }
    const exists = (cs: string) => {
      if (this.byCallsign(cs)) {
        this.log(`${cs} already exists, not spawned again`, "warn");
        return true;
      }
      return false;
    };
    switch (c.kind) {
      case "SPAWN":
        if (!exists(c.cs)) this.add(spawnAirborne(c.cs, c.type, c));
        return;
      case "DEP": {
        if (exists(c.cs)) return;
        const ac = spawnDeparture(c.cs, c.type, c);
        if (!ac) this.log(`DEP ${c.cs}: unknown runway ${c.runway}`, "warn");
        this.add(ac);
        return;
      }
      case "GATE":
        if (exists(c.cs) || this.tryGate(c)) return;
        // every stand taken: it appears as soon as one frees up
        this.pendingGates.push({ cmd: c, held: [] });
        return;
      case "AUTO": {
        const ac = this.need(c.cs, "AUTO");
        if (ac) autoTaxi(ac, this, c.runway, c.clr ?? false, c.full ?? false);
        return;
      }
      case "AUTOLAND": {
        const ac = this.need(c.cs, "AUTOLAND");
        if (!ac) return;
        if (ac.onGround || !ac.arr) {
          this.log(`AUTOLAND ${c.cs}: ${ac.onGround ? "aircraft is on the ground" : "no destination"}`, "warn");
          return;
        }
        // its route (if any), then a final at the destination; it keeps its own separation meanwhile
        ac.homing = true;
        ac.autoLand ??= { rwy: null };
        ac.autoFlight ??= this.simTotal;
        return;
      }
      case "APPR": {
        const ac = this.need(c.cs, "APPR");
        if (!ac) return;
        if (ac.onGround) this.log(`APPR ${c.cs}: aircraft is on the ground`, "warn");
        else clearApproach(ac, c.runway);
        return;
      }
      case "CCT": {
        const ac = this.need(c.cs, "CCT");
        if (!ac) return;
        try {
          const cct = makeCircuit(ac, c.runway, { side: c.side, tng: c.tng, join: c.join });
          if (ac.onGround) ac.cctAfterTakeoff = { rwy: cct.rwy, side: cct.side, tng: cct.tng };
          else {
            ac.cct = cct;
            ac.fixList = [];
            ac.approach = null;
            ac.hold = null;
            ac.homing = false;
            if (ac.dep) ac.dep.overridden = true;
          }
        } catch (e) {
          this.log(`CCT ${c.cs}: ${(e as Error).message}`, "warn");
        }
        return;
      }
      case "CLMB": {
        (this.strips[c.cs] ??= {}).clmb = String(c.ft);
        const ac = this.byCallsign(c.cs);
        if (ac?.gnd) ac.gnd.climb = c.ft;
        return;
      }
      case "ROLLOUT":
        this.rolloutMode = c.mode;
        this.log(`ROLLOUT ${c.mode}`);
        return;
      case "ALT":
      case "SPD":
      case "HDG": {
        const ac = this.need(c.cs, c.kind);
        if (!ac) return;
        if (ac.onGround) {
          this.log(`${c.kind} ${c.cs}: aircraft is on the ground`, "warn");
          return;
        }
        if (c.kind === "ALT") {
          ac.assigned.alt = c.value;
          ac.approach = null;
          ac.apprCaptured = false;
          this.setScriptTag(ac, { alt: c.value });
        } else if (c.kind === "SPD") {
          ac.assigned.speed = c.value;
          this.setScriptTag(ac, { speed: c.value });
        } else {
          ac.assigned.heading = c.value;
          ac.fixList = [];
          ac.approach = null;
          ac.apprCaptured = false;
          ac.hold = null;
          ac.cct = null;
          ac.homing = false;
          if (ac.dep) ac.dep.overridden = true;
          this.setScriptTag(ac, { heading: c.value });
        }
        return;
      }
      case "EMERGENCY": {
        const ac = this.need(c.cs, "EMERGENCY");
        if (ac) toggleEmergency(ac, this);
        return;
      }
      case "COMMENT":
        this.log(c.text, "comment");
        return;
      case "CMD": {
        this.cmds.push({ id: ++this.cmdSeq, text: c.text });
        if (this.cmds.length > 100) this.cmds.shift();
        this.log(`CMD ${c.text}`, "cmd");
        // LDARPT <ICAO> TWR opens TWR mode; any other view closes it
        const m = /^\.?LDARPT\s+(\S+)(?:\s+(\S+))?/i.exec(c.text);
        if (m) {
          this.airport = m[1]!.toUpperCase();
          this.setTwr((m[2] ?? "CTR").toUpperCase() === "TWR");
        }
        // RWYCFG <ICAO> <DEP> <ARR,...>: automatic departures overflow onto these runways in order
        const rc = /^\.?RWYCFG\s+(\S+)\s+(\S+)\s+(\S+)$/i.exec(c.text.trim());
        if (rc) this.runwayConfig = { apt: rc[1]!.toUpperCase(), dep: rc[2]!.toUpperCase(), arr: rc[3]!.toUpperCase().split(",").filter(Boolean) };
        return;
      }
    }
  }

  // ---- host control ------------------------------------------------------------------------------------

  aircraftOr404(id: string): Aircraft {
    const ac = this.byId(id);
    if (!ac) throw notFound("NO_AIRCRAFT", "No such aircraft in this session");
    return ac;
  }

  hostControl(kind: "air" | "gnd" | "twr", id: string, body: AirBody | GndBody | TwrBody): AircraftDTO {
    const ac = this.aircraftOr404(id);
    let res: ControlResult;
    if (kind === "air") res = airControl(ac, body as AirBody, this);
    else if (kind === "gnd") res = gndControl(ac, body as GndBody, this);
    else res = twrControl(ac, body as TwrBody, this);
    this.log(`HOST ${res.act} ${ac.callsign} → ${res.value}`, "host");
    this.counters.hostCmds[res.act] = (this.counters.hostCmds[res.act] ?? 0) + 1;
    const dto = this.dto(ac, true);
    if (ac.gone) this.aircraft = this.aircraft.filter((a) => !a.gone);
    return dto;
  }

  setStrip(callsign: string, key: string, value: string): void {
    const v = value.trim().toUpperCase().slice(0, config.limits.stripValueMax);
    const strip = (this.strips[callsign] ??= {});
    if (v) strip[key] = v;
    else delete strip[key];
    if (!Object.keys(strip).length) delete this.strips[callsign];
  }

  // ---- end, stats, replay ------------------------------------------------------------------------------

  stats(now = Date.now()): SessionStats {
    const startedAt = this.startedAt ?? this.createdAt;
    const endedAt = this.endedAt ?? now;
    const hostInstructions = Object.entries(this.counters.hostCmds)
      .filter(([k]) => k !== "DEL" && k !== "EMER")
      .reduce((s, [, v]) => s + v, 0);
    return {
      code: this.code,
      scriptName: this.scriptName,
      startedAt,
      endedAt,
      wallSec: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
      simSec: this.simTotal,
      spawned: this.counters.spawned,
      landed: this.counters.landed,
      arrived: this.counters.arrived,
      deleted: this.counters.deleted,
      remaining: this.aircraft.length,
      peakTraffic: this.counters.peakTraffic,
      emergencies: this.counters.emergencies,
      separationLosses: this.counters.separationLosses,
      hostInstructions,
      hostBreakdown: { ...this.counters.hostCmds },
      scriptCommandsRun: this.counters.scriptCommandsRun,
      scriptCommandsLeft: this.script.length,
    };
  }

  /** End the session (idempotent). */
  end(): SessionStats {
    if (this.ended && this.finalStats) return this.finalStats;
    this.running = false;
    this.ended = true;
    this.endedAt = Date.now();
    this.log("Session ended");
    this.finalStats = this.stats(this.endedAt);
    return this.finalStats;
  }

  replay(): ReplayFile {
    return {
      format: REPLAY_FORMAT,
      version: 1,
      code: this.code,
      scriptName: this.scriptName,
      exportedAt: Date.now(),
      stats: this.finalStats ?? this.stats(),
      frameFields: [...REPLAY_FRAME_FIELDS],
      events: this.events,
      frames: this.frames,
    };
  }

  // ---- snapshots ---------------------------------------------------------------------------------------

  dto(ac: Aircraft, host: boolean): AircraftDTO {
    const g = ac.gnd;
    const cct = ac.cct
      ? { rwy: ac.cct.rwy, side: ac.cct.side, leg: ac.cct.leg, tng: ac.cct.tng, ext: ac.cct.ext }
      : ac.cctAfterTakeoff
        ? { rwy: ac.cctAfterTakeoff.rwy, side: ac.cctAfterTakeoff.side ?? "L", leg: "up" as const, tng: ac.cctAfterTakeoff.tng, ext: false }
        : null;
    return {
      id: ac.id,
      callsign: ac.callsign,
      type: ac.type,
      wake: ac.wake,
      x: round(ac.pos.x, 4),
      y: round(ac.pos.y, 4),
      heading: Math.round(ac.heading) % 360,
      altitude: Math.round(ac.altitude),
      groundSpeed: Math.round(ac.groundSpeed),
      verticalSpeed: ac.verticalSpeed,
      trail: ac.trail.map((p) => [round(p.x, 4), round(p.y, 4)]),
      onGround: ac.onGround,
      emergency: ac.emergency,
      assigned: { alt: Math.round(ac.assigned.alt), heading: Math.round(ac.assigned.heading), speed: Math.round(ac.assigned.speed) },
      fixList: ac.fixList.map((f) => f.name),
      fixPts: ac.fixList.map((f) => [round(f.pos.x, 4), round(f.pos.y, 4)]),
      approach: ac.approach,
      landClr: ac.landClr,
      cct,
      hold: ac.hold ? { fix: ac.hold.fix, crs: ac.hold.crs, dir: ac.hold.dir, leg: ac.hold.leg, ph: ac.hold.ph } : null,
      gnd: g
        ? {
            apt: g.apt,
            mode: g.mode,
            status: g.status,
            stand: g.stand,
            ...(host ? { path: plannedPath(ac) } : {}),
            pushFacing: g.pushFacing.map((o) => ({ hdg: o.hdg, twy: o.twy })),
            rwy: g.rwy,
            climb: g.climb,
            spacing: g.spacing,
            paused: g.paused,
          }
        : null,
      scriptTag: ac.scriptTag,
    };
  }

  flightPlans(): FlightPlanDTO[] {
    return this.aircraft.map((ac) => ({ aircraftId: ac.id, ...ac.fp }));
  }

  presentClients(now = Date.now()): ClientDTO[] {
    const window = SC.clientSeenWindowSec * 2000;
    return [...this.clients.values()]
      .filter((c) => now - c.lastSeen <= window)
      .map((c) => ({ name: c.name, user: c.user, host: c.host, connectedSec: Math.round((now - c.firstSeen) / 1000) }));
  }

  /** Shared part of every snapshot this tick (aircraft for hosts and viewers). */
  snapshotBase(): { host: AircraftDTO[]; viewer: AircraftDTO[]; flightPlans: FlightPlanDTO[]; clients: ClientDTO[] } {
    return {
      host: this.aircraft.map((a) => this.dto(a, true)),
      viewer: this.aircraft.map((a) => this.dto(a, false)),
      flightPlans: this.flightPlans(),
      clients: this.presentClients(),
    };
  }

  snapshotFor(v: Viewer, base = this.snapshotBase()): Snapshot {
    const log = this.logEntries.filter((e) => e.seq > v.lastLogSeq).map(({ seq, atSec, message, level }) => ({ seq, atSec, message, level }));
    const cmds = this.cmds.filter((c) => c.id > v.lastCmdId);
    v.lastLogSeq = this.logSeq;
    v.lastCmdId = Math.max(v.lastCmdId, this.cmdSeq);
    return {
      t: "snapshot",
      code: this.code,
      running: this.running,
      speed: this.speed,
      elapsedSec: this.elapsedSec,
      simTotal: this.simTotal,
      scriptName: this.scriptName,
      commandsRemaining: this.script.length,
      twr: this.twrMode,
      rollout: this.rolloutMode,
      ended: this.ended,
      stats: this.finalStats,
      aircraft: v.host ? base.host : base.viewer,
      flightPlans: base.flightPlans,
      strips: this.strips,
      log,
      cmds,
      ...(v.host ? { clients: base.clients } : {}),
    };
  }

  info() {
    return {
      code: this.code,
      hostId: this.hostId,
      scriptName: this.scriptName,
      running: this.running,
      speed: this.speed,
      elapsedSec: this.elapsedSec,
      ended: this.ended,
    };
  }
}
