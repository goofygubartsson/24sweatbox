// Sweatbox files (.sbx, spec section 7). Shared by the server (loading) and the Maker (live
// validation), so both give exactly the same errors.
//
//   # comments start with "#"
//   [sweatbox]
//   name = TWR-IRFD-25                  optional
//   airport = IRFD                      the airport the runways and stands below belong to
//   view = TWR                          CTR, GND or TWR: what every scope shows
//   departure runway = 25R              optional: extended centrelines on the scope...
//   arrival runways = 25L, 25C          ...for these runways
//   after landing = stand               remove, hold (vacate and wait) or stand (taxi in)
//
//   [00:00] parked: callsign=CEB9740 type=A332 stand=1 level=FL300 route=HDG071 to=IZOL climb=4000
//   [00:30] airborne: callsign=THA89 type=A333 position=34.522,4.559 altitude=3800 speed=180 ...
//
// One event per line: "[mm:ss]" (or "[h:mm:ss]") from the start, the event name, then key=value
// fields in any order; values with spaces go in quotes. Lines with the same time run in order.
// The events and their fields are listed in EVENTS (and the docs).
//
// Any syntax error rejects the whole file; every error is returned as "Line N: ...". Semantic
// problems (unknown runway / fix / stand, an aircraft that isn't there yet) are warnings: the
// event is skipped with a log line when it runs.
//
// Internally a file becomes a list of commands (ScriptCommand) that the sim runs; the header
// becomes commands at 00:00 (the scope view and runways for everyone, what happens after landing).
import { getAirport, getFix, groundMapsData } from "./world";
import { findRunwayEnd } from "./runways";
import { isSidToken } from "./routes";

export type JoinLeg = "DW" | "BASE" | "UP" | "CROSS" | "DOWN";
export type RolloutMode = "OFF" | "HOLD" | "STAND";
export type ScopeView = "CTR" | "GND" | "TWR";

interface Base {
  offset: number;
  line: number;
  raw: string;
}

/** What the sim runs (one file line can become several). */
export type ScriptCommand = Base &
  (
    | { kind: "SPAWN"; cs: string; type: string; alt: number; rfl: string; gs: number; route: string; dep: string; arr: string; x: number; y: number }
    | { kind: "DEP"; cs: string; type: string; runway: string; climb: number; rfl: string; route: string; arr: string; spd: number }
    | { kind: "GATE"; cs: string; type: string; apt: string; stand: string; rfl: string; route: string; arr: string }
    | { kind: "AUTO"; cs: string; runway: string; clr?: boolean; full?: boolean }
    | { kind: "APPR"; cs: string; runway: string }
    | { kind: "AUTOLAND"; cs: string }
    | { kind: "CCT"; cs: string; runway: string; side: "L" | "R"; tng: boolean; join: JoinLeg }
    | { kind: "CLMB"; cs: string; ft: number }
    | { kind: "ROLLOUT"; mode: RolloutMode }
    | { kind: "ALT" | "SPD" | "HDG"; cs: string; value: number }
    | { kind: "EMERGENCY"; cs: string }
    | { kind: "COMMENT"; text: string }
    | { kind: "CMD"; text: string }
  );

export type CommandKind = ScriptCommand["kind"];

/** The [sweatbox] section. */
export interface ScriptHeader {
  name: string | null;
  airport: string;
  view: ScopeView;
  /** Designators, e.g. "25R" and ["25L", "25C"]. */
  depRunway: string | null;
  arrRunways: string[];
  afterLanding: RolloutMode | null;
}

export interface ParseResult {
  ok: boolean;
  /** Sorted (stable) by time. Empty when there are errors. */
  commands: ScriptCommand[];
  header: ScriptHeader | null;
  errors: string[];
  warnings: string[];
  /** Line numbers with errors / warnings, for editors. */
  errorLines: number[];
  warningLines: number[];
}

// ---- values -------------------------------------------------------------------------------------------

const CS_RE = /^[A-Z0-9]{2,12}$/;
const TYPE_RE = /^[A-Z0-9]{2,5}$/;
const APT_RE = /^I[A-Z0-9]{3}$/;
const RWY_RE = /^(I[A-Z0-9]{3})-(\d{2}[LCR]?)$/;
const DESIGNATOR_RE = /^\d{2}[LCR]?$/;
const STAND_RE = /^[A-Z0-9]+$/;
const RFL_RE = /^(?:FL?)?(\d{1,3})$/;
const ROUTE_TOKEN_RE = /^[A-Z0-9]{2,7}(?:\.[A-Z0-9]{2,7})?$/;

export class LineError extends Error {}

export const fail = (msg: string): never => {
  throw new LineError(msg);
};

export function int(s: string | undefined, what: string, min: number, max: number): number {
  if (s === undefined || !/^-?\d+$/.test(s)) return fail(`invalid ${what} "${s ?? ""}"`);
  const n = Number(s);
  if (n < min || n > max) return fail(`${what} ${n} out of range (${min}-${max})`);
  return n;
}

export function coord(s: string | undefined): number {
  const n = Number(s);
  if (s === undefined || s === "" || !Number.isFinite(n)) return fail(`invalid coordinate "${s ?? ""}"`);
  return n;
}

export const callsign = (s: string | undefined): string => {
  const v = (s ?? "").toUpperCase();
  return CS_RE.test(v) ? v : fail(`invalid callsign "${s ?? ""}"`);
};
export const acType = (s: string | undefined): string => {
  const v = (s ?? "").toUpperCase();
  return TYPE_RE.test(v) ? v : fail(`invalid aircraft type "${s ?? ""}"`);
};
export const airportCode = (s: string | undefined): string => {
  const v = (s ?? "").toUpperCase();
  return APT_RE.test(v) ? v : fail(`invalid airport "${s ?? ""}"`);
};
export const runwayName = (s: string | undefined): string => {
  const v = (s ?? "").toUpperCase();
  return RWY_RE.test(v) ? v : fail(`invalid runway "${s ?? ""}" (expected APT-RWY like IRFD-25L)`);
};
export const level = (s: string | undefined): string => {
  const m = RFL_RE.exec((s ?? "").toUpperCase());
  return m ? m[1]!.padStart(3, "0") : fail(`invalid level "${s ?? ""}" (like FL300)`);
};

/** Validate a route: HDGxxx, CCT, VIS or a comma list of fixes / SID tokens. */
export function validateRoute(s: string | undefined): string {
  const v = (s ?? "").toUpperCase();
  if (v.startsWith("HDG")) {
    const m = /^HDG(\d{1,3})$/.exec(v);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 360) fail(`invalid HDG route "${s}"`);
    return `HDG${m![1]!.padStart(3, "0")}`;
  }
  if (v === "CCT" || v === "VIS") return v;
  const tokens = v.split(",");
  for (const t of tokens) if (!ROUTE_TOKEN_RE.test(t)) fail(`invalid route "${s ?? ""}" (bad element "${t}")`);
  return tokens.join(",");
}

type Parsed = ScriptCommand extends infer T ? (T extends ScriptCommand ? Omit<T, keyof Base> : never) : never;

/** A command without its source position (for building scripts). */
export type CommandInput = Parsed & { offset: number };

// ---- events -------------------------------------------------------------------------------------------

type Fields = Map<string, string>;

interface EventSpec {
  required: string[];
  optional: string[];
  /** One line of help, also shown by the Maker and the docs. */
  help: string;
  build(f: Fields, airport: string): Parsed[];
}

/** "25R" (on the file's airport) or "IRFD-25R". */
function runwayOn(airport: string, s: string | undefined): string {
  const v = (s ?? "").toUpperCase();
  return runwayName(DESIGNATOR_RE.test(v) ? `${airport}-${v}` : v);
}

function position(s: string | undefined): [number, number] {
  const parts = (s ?? "").split(",");
  if (parts.length !== 2) return fail(`invalid position "${s ?? ""}" (expected x,y like 34.52,4.56)`);
  return [coord(parts[0]), coord(parts[1])];
}

const SIDES: Record<string, "L" | "R"> = { LEFT: "L", RIGHT: "R" };
const CIRCUIT_TYPES: Record<string, boolean> = { "TOUCH-AND-GO": true, "FULL-STOP": false };
const JOINS: Record<string, JoinLeg> = { DOWNWIND: "DW", "ON-DOWNWIND": "DOWN", BASE: "BASE", UPWIND: "UP", CROSSWIND: "CROSS" };
const choice = <T>(map: Record<string, T>, what: string, s: string | undefined): T => {
  const v = (s ?? "").toUpperCase();
  return v in map ? map[v]! : fail(`invalid ${what} "${s ?? ""}" (${Object.keys(map).join(", ").toLowerCase()})`);
};

export const EVENTS: Record<string, EventSpec> = {
  parked: {
    required: ["callsign", "type", "stand", "level", "route", "to"],
    optional: ["climb", "airport"],
    help: 'on a stand ("any" = the next stand that frees up), waiting for a pushback',
    build: (f, airport) => {
      const stand = (f.get("stand") ?? "").toUpperCase();
      if (stand !== "ANY" && !STAND_RE.test(stand)) fail(`invalid stand "${f.get("stand")}"`);
      const cs = callsign(f.get("callsign"));
      const out: Parsed[] = [
        {
          kind: "GATE",
          cs,
          type: acType(f.get("type")),
          apt: f.has("airport") ? airportCode(f.get("airport")) : airport,
          stand: stand === "ANY" ? "*" : stand,
          rfl: level(f.get("level")),
          route: validateRoute(f.get("route")),
          arr: airportCode(f.get("to")),
        },
      ];
      if (f.has("climb")) out.push({ kind: "CLMB", cs, ft: int(f.get("climb"), "climb", 0, 99999) });
      return out;
    },
  },
  airborne: {
    required: ["callsign", "type", "position", "altitude", "speed", "level", "route", "from", "to"],
    optional: [],
    help: "flying, at a map position",
    build: (f) => {
      const [x, y] = position(f.get("position"));
      return [
        {
          kind: "SPAWN",
          cs: callsign(f.get("callsign")),
          type: acType(f.get("type")),
          alt: int(f.get("altitude"), "altitude", 0, 99999),
          rfl: level(f.get("level")),
          gs: int(f.get("speed"), "speed", 1, 2000),
          route: validateRoute(f.get("route")),
          dep: airportCode(f.get("from")),
          arr: airportCode(f.get("to")),
          x,
          y,
        },
      ];
    },
  },
  departing: {
    required: ["callsign", "type", "runway", "climb", "level", "route", "to"],
    optional: ["speed"],
    help: "just airborne off a runway",
    build: (f, airport) => [
      {
        kind: "DEP",
        cs: callsign(f.get("callsign")),
        type: acType(f.get("type")),
        runway: runwayOn(airport, f.get("runway")),
        climb: int(f.get("climb"), "climb", 0, 99999),
        rfl: level(f.get("level")),
        route: validateRoute(f.get("route")),
        arr: airportCode(f.get("to")),
        spd: f.has("speed") ? int(f.get("speed"), "speed", 1, 2000) : 250,
      },
    ],
  },
  autodep: {
    required: ["callsign", "runway"],
    optional: ["when", "takeoff"],
    help: "a parked aircraft pushes, taxis to a holding point and waits for the controller (takeoff=auto: also lines up and takes off by itself; when=cleared: only after the C tick, then all by itself)",
    build: (f, airport) => {
      const when = (f.get("when") ?? "now").toLowerCase();
      if (when !== "now" && when !== "cleared") fail(`invalid when "${f.get("when")}" (now, cleared)`);
      const takeoff = (f.get("takeoff") ?? "controller").toLowerCase();
      if (takeoff !== "controller" && takeoff !== "auto") fail(`invalid takeoff "${f.get("takeoff")}" (controller, auto)`);
      return [
        {
          kind: "AUTO",
          cs: callsign(f.get("callsign")),
          runway: runwayOn(airport, f.get("runway")),
          ...(when === "cleared" ? { clr: true } : {}),
          ...(takeoff === "auto" && when !== "cleared" ? { full: true } : {}),
        },
      ];
    },
  },
  approach: {
    required: ["callsign", "runway"],
    optional: [],
    help: "cleared for the approach",
    build: (f, airport) => [{ kind: "APPR", cs: callsign(f.get("callsign")), runway: runwayOn(airport, f.get("runway")) }],
  },
  autoland: {
    required: ["callsign"],
    optional: [],
    help: "an airborne aircraft flies its route, then joins a final at its destination and lands by itself, keeping its own separation, until a controller instructs it",
    build: (f) => [{ kind: "AUTOLAND", cs: callsign(f.get("callsign")) }],
  },
  circuit: {
    required: ["callsign", "runway", "side"],
    optional: ["type", "join"],
    help: "flies circuits (side=left|right, type=touch-and-go|full-stop, join=downwind|on-downwind|base|upwind|crosswind)",
    build: (f, airport) => [
      {
        kind: "CCT",
        cs: callsign(f.get("callsign")),
        runway: runwayOn(airport, f.get("runway")),
        side: choice(SIDES, "side", f.get("side")),
        tng: f.has("type") ? choice(CIRCUIT_TYPES, "circuit type", f.get("type")) : true,
        join: f.has("join") ? choice(JOINS, "join", f.get("join")) : "DW",
      },
    ],
  },
  climb: {
    required: ["callsign", "altitude"],
    optional: [],
    help: "initial climb for a departure (the strip's CLMB)",
    build: (f) => [{ kind: "CLMB", cs: callsign(f.get("callsign")), ft: int(f.get("altitude"), "altitude", 0, 99999) }],
  },
  assign: {
    required: ["callsign"],
    optional: ["altitude", "speed", "heading"],
    help: "an altitude, speed and / or heading for an aircraft",
    build: (f) => {
      const cs = callsign(f.get("callsign"));
      const out: Parsed[] = [];
      if (f.has("altitude")) out.push({ kind: "ALT", cs, value: int(f.get("altitude"), "altitude", 0, 99999) });
      if (f.has("speed")) out.push({ kind: "SPD", cs, value: int(f.get("speed"), "speed", 1, 2000) });
      if (f.has("heading")) {
        const h = int(f.get("heading"), "heading", 0, 360);
        out.push({ kind: "HDG", cs, value: h === 0 ? 360 : h });
      }
      if (!out.length) fail("assign needs altitude, speed or heading");
      return out;
    },
  },
  emergency: {
    required: ["callsign"],
    optional: [],
    help: "declares an emergency",
    build: (f) => [{ kind: "EMERGENCY", cs: callsign(f.get("callsign")) }],
  },
  message: {
    required: ["text"],
    optional: [],
    help: "a line in everyone's message area",
    build: (f) => [{ kind: "COMMENT", text: f.get("text")!.trim() || fail("message needs text") }],
  },
};

/** "callsign=… type=…" usage line per event, for the Maker and the docs. */
export const SCRIPT_USAGE: Record<string, string> = Object.fromEntries(
  Object.entries(EVENTS).map(([name, e]) => [name, [...e.required.map((k) => `${k}=…`), ...e.optional.map((k) => `[${k}=…]`)].join(" ")]),
);

// ---- header -------------------------------------------------------------------------------------------

const HEADER_KEYS = ["name", "airport", "view", "departure runway", "arrival runways", "after landing"] as const;
const AFTER_LANDING: Record<string, RolloutMode> = { REMOVE: "OFF", HOLD: "HOLD", STAND: "STAND" };

function headerCommands(h: ScriptHeader): Parsed[] {
  const out: Parsed[] = [{ kind: "CMD", text: `LDARPT ${h.airport} ${h.view}` }];
  if (h.depRunway || h.arrRunways.length) {
    const dep = h.depRunway ?? h.arrRunways[0]!;
    const arr = h.arrRunways.length ? h.arrRunways : [dep];
    out.push({ kind: "CMD", text: `RWYCFG ${h.airport} ${dep} ${arr.join(",")}` });
  }
  if (h.afterLanding) out.push({ kind: "ROLLOUT", mode: h.afterLanding });
  return out;
}

// ---- parsing ------------------------------------------------------------------------------------------

const TIME_LINE = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([A-Za-z]+)\s*:\s*(.*)$/;
const FIELD = /\s*([A-Za-z][A-Za-z-]*)\s*=\s*(?:"([^"]*)"|([^\s"]+))/y;
/** "0 SPAWN …" or "120 CMD …": the old line layout. */
const OLD_LINE = /^\d+(\.\d+)?\s+[A-Za-z]+\b/;

function parseTime(m: RegExpExecArray): number {
  const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
  if (c === null) {
    if (b > 59) fail(`invalid time "[${m[1]}:${m[2]}]" (seconds 00-59)`);
    return a * 60 + b;
  }
  if (b > 59 || c > 59) fail(`invalid time "[${m[1]}:${m[2]}:${m[3]}]"`);
  return a * 3600 + b * 60 + c;
}

function parseFields(event: string, rest: string): Fields {
  const f: Fields = new Map();
  if (event === "message") {
    // the text runs to the end of the line, quotes optional
    const m = /^text\s*=\s*(.*)$/i.exec(rest.trim());
    if (!m) fail('message needs text="…"');
    f.set("text", m![1]!.replace(/^"(.*)"$/, "$1"));
    return f;
  }
  FIELD.lastIndex = 0;
  let pos = 0;
  while (pos < rest.length) {
    if (!rest.slice(pos).trim()) break;
    FIELD.lastIndex = pos;
    const m = FIELD.exec(rest);
    if (!m) fail(`expected key=value at "${rest.slice(pos).trim().slice(0, 24)}"`);
    const key = m![1]!.toLowerCase();
    if (f.has(key)) fail(`${key} given twice`);
    f.set(key, m![2] ?? m![3]!);
    pos = FIELD.lastIndex;
  }
  return f;
}

function parseEvent(name: string, rest: string, airport: string): Parsed[] {
  const spec = EVENTS[name];
  if (!spec) return fail(`unknown event "${name}" (${Object.keys(EVENTS).join(", ")})`);
  const f = parseFields(name, rest);
  for (const k of f.keys()) if (!spec.required.includes(k) && !spec.optional.includes(k)) fail(`${name} has no field "${k}" (${SCRIPT_USAGE[name]})`);
  const missing = spec.required.filter((k) => !f.has(k));
  if (missing.length) fail(`${name} needs ${missing.join(", ")} (${SCRIPT_USAGE[name]})`);
  return spec.build(f, airport);
}

function parseHeaderLine(raw: string, h: Partial<Record<(typeof HEADER_KEYS)[number], string>>): void {
  const m = /^([A-Za-z ]+?)\s*=\s*(.*)$/.exec(raw);
  if (!m) fail('expected "setting = value" in [sweatbox]');
  const key = m![1]!.toLowerCase().replace(/\s+/g, " ") as (typeof HEADER_KEYS)[number];
  if (!HEADER_KEYS.includes(key)) fail(`unknown setting "${m![1]}" (${HEADER_KEYS.join(", ")})`);
  if (key in h) fail(`${key} given twice`);
  h[key] = m![2]!.trim();
}

function buildHeader(h: Partial<Record<(typeof HEADER_KEYS)[number], string>>): ScriptHeader {
  if (!h.airport) fail("[sweatbox] needs airport = …");
  const airport = airportCode(h.airport);
  const view = (h.view ?? "CTR").toUpperCase();
  if (view !== "CTR" && view !== "GND" && view !== "TWR") fail(`invalid view "${h.view}" (CTR, GND, TWR)`);
  const designator = (s: string) => (DESIGNATOR_RE.test(s.toUpperCase()) ? s.toUpperCase() : fail(`invalid runway "${s}" (like 25R)`));
  return {
    name: h.name || null,
    airport,
    view: view as ScopeView,
    depRunway: h["departure runway"] ? designator(h["departure runway"]) : null,
    arrRunways: h["arrival runways"] ? h["arrival runways"].split(/[\s,]+/).filter(Boolean).map(designator) : [],
    afterLanding: h["after landing"] ? choice(AFTER_LANDING, "after landing", h["after landing"]) : null,
  };
}

/** Semantic checks against the world data. Returns warning texts (without the "Line N:" prefix). */
function semanticWarnings(c: ScriptCommand, spawned: Set<string>): string[] {
  const w: string[] = [];
  const rwy = (name: string) => {
    if (!findRunwayEnd(name)) w.push(`unknown runway ${name}`);
  };
  const airport = (code: string) => {
    if (!getAirport(code)) w.push(`unknown airport ${code}`);
  };
  const route = (r: string, dep: string | null) => {
    if (r.startsWith("HDG") || r === "CCT" || r === "VIS") return;
    for (const t of r.split(",")) if (!getFix(t) && !(dep && isSidToken(dep, t))) w.push(`unknown fix or SID ${t}`);
  };
  const known = (cs: string) => {
    if (!spawned.has(cs)) w.push(`${cs} isn't there yet (no parked / airborne / departing line before this)`);
  };
  switch (c.kind) {
    case "SPAWN":
      airport(c.dep);
      airport(c.arr);
      route(c.route, c.dep);
      spawned.add(c.cs);
      break;
    case "DEP":
      rwy(c.runway);
      airport(c.arr);
      route(c.route, c.runway.split("-")[0]!);
      spawned.add(c.cs);
      break;
    case "GATE": {
      airport(c.apt);
      airport(c.arr);
      route(c.route, c.apt);
      const g = groundMapsData[c.apt];
      if (!g?.ground) w.push(`${c.apt} has no ground map: ${c.cs} cannot be parked`);
      else if (c.stand !== "*" && !g.ground.stands.some((s) => s.name.toUpperCase() === c.stand)) w.push(`unknown stand ${c.apt}-${c.stand}`);
      spawned.add(c.cs);
      break;
    }
    case "AUTO":
    case "APPR":
    case "CCT":
      rwy(c.runway);
      known(c.cs);
      break;
    case "CLMB":
    case "ALT":
    case "SPD":
    case "HDG":
    case "EMERGENCY":
    case "AUTOLAND":
      known(c.cs);
      break;
  }
  return w;
}

export const OLD_FORMAT_ERROR =
  'this is an old-format sweatbox file ("0 SPAWN …" lines). Sweatbox files now start with [sweatbox] and use lines like "[00:00] airborne: callsign=…"; convert it with: pnpm sbx:convert <file>';

export function parseScript(text: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const errorLines: number[] = [];
  const warningLines: number[] = [];
  const commands: ScriptCommand[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const err = (line: number, msg: string) => {
    errors.push(`Line ${line}: ${msg}`);
    errorLines.push(line);
  };
  const result = (header: ScriptHeader | null): ParseResult => {
    const ok = errors.length === 0;
    return { ok, commands: ok ? commands : [], header: ok ? header : null, errors, warnings, errorLines, warningLines };
  };

  // the file opens with [sweatbox]; an old "<seconds> <COMMAND>" file gets one clear error
  const first = lines.findIndex((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (first < 0) {
    err(1, "the file is empty (it starts with [sweatbox])");
    return result(null);
  }
  if (OLD_LINE.test(lines[first]!.trim())) {
    err(first + 1, OLD_FORMAT_ERROR);
    return result(null);
  }
  if (lines[first]!.trim().toLowerCase() !== "[sweatbox]") {
    err(first + 1, "the file must start with [sweatbox]");
    return result(null);
  }

  const raw: Partial<Record<(typeof HEADER_KEYS)[number], string>> = {};
  let header: ScriptHeader | null = null;
  let headerLine = first + 1;
  for (let i = first + 1; i < lines.length; i++) {
    const line = i + 1;
    const text = lines[i]!.trim();
    if (text === "" || text.startsWith("#")) continue;
    try {
      const m = TIME_LINE.exec(text);
      if (!m) {
        if (header) fail('expected "[mm:ss] event: key=value …" (settings go before the first event)');
        if (OLD_LINE.test(text)) fail(OLD_FORMAT_ERROR);
        parseHeaderLine(text, raw);
        headerLine = line;
        continue;
      }
      if (!header) {
        header = buildHeader(raw);
        for (const p of headerCommands(header)) commands.push({ ...p, offset: 0, line: headerLine, raw: "[sweatbox]" } as ScriptCommand);
      }
      const offset = parseTime(m);
      for (const p of parseEvent(m[4]!.toLowerCase(), m[5] ?? "", header.airport)) commands.push({ ...p, offset, line, raw: text } as ScriptCommand);
    } catch (e) {
      if (!(e instanceof LineError)) throw e;
      err(line, e.message);
    }
  }
  if (!header && errors.length === 0) {
    try {
      header = buildHeader(raw);
    } catch (e) {
      if (!(e instanceof LineError)) throw e;
      err(headerLine, e.message);
    }
    if (header) err(headerLine, "the file has no events");
  }
  // stable sort by time (Array.prototype.sort is stable)
  commands.sort((a, b) => a.offset - b.offset);
  if (errors.length === 0) {
    const spawned = new Set<string>();
    for (const c of commands)
      for (const w of semanticWarnings(c, spawned)) {
        warnings.push(`Line ${c.line}: ${w}`);
        warningLines.push(c.line);
      }
  }
  return result(header);
}

// ---- writing ------------------------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "[mm:ss]", or "[h:mm:ss]" from an hour on. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `[${h}:${pad2(m)}:${pad2(s % 60)}]` : `[${pad2(m)}:${pad2(s % 60)}]`;
}

const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "'")}"` : v);

/** One event line. Fields without a value are left out. */
export function eventLine(offset: number, event: string, fields: [string, string | number | null | undefined][]): string {
  const parts = fields.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${quote(String(v))}`);
  return `${formatTime(offset)} ${event}: ${parts.join(" ")}`;
}

/** The [sweatbox] section. */
export function formatHeader(h: ScriptHeader): string[] {
  const after = h.afterLanding ? Object.entries(AFTER_LANDING).find(([, v]) => v === h.afterLanding)![0].toLowerCase() : null;
  return [
    "[sweatbox]",
    ...(h.name ? [`name = ${h.name}`] : []),
    `airport = ${h.airport}`,
    `view = ${h.view}`,
    ...(h.depRunway ? [`departure runway = ${h.depRunway}`] : []),
    ...(h.arrRunways.length ? [`arrival runways = ${h.arrRunways.join(", ")}`] : []),
    ...(after ? [`after landing = ${after}`] : []),
  ];
}

const fmtCoord = (n: number) => String(Math.round(n * 1e5) / 1e5);
const fl = (rfl: string) => `FL${rfl}`;
const keyOf = <T>(map: Record<string, T>, v: T) => Object.entries(map).find(([, x]) => x === v)![0].toLowerCase();

/** A command as an event line; runways on `airport` are written as designators ("25R"). Header-only
 * commands (scope view, runways, after landing) have no event line: null. */
export function formatCommand(c: ScriptCommand | CommandInput, airport: string): string | null {
  const rwy = (r: string) => (r.startsWith(`${airport}-`) ? r.slice(airport.length + 1) : r);
  const t = c.offset;
  switch (c.kind) {
    case "SPAWN":
      return eventLine(t, "airborne", [
        ["callsign", c.cs],
        ["type", c.type],
        ["position", `${fmtCoord(c.x)},${fmtCoord(c.y)}`],
        ["altitude", c.alt],
        ["speed", c.gs],
        ["level", fl(c.rfl)],
        ["route", c.route],
        ["from", c.dep],
        ["to", c.arr],
      ]);
    case "DEP":
      return eventLine(t, "departing", [
        ["callsign", c.cs],
        ["type", c.type],
        ["runway", rwy(c.runway)],
        ["climb", c.climb],
        ["level", fl(c.rfl)],
        ["route", c.route],
        ["to", c.arr],
        ["speed", c.spd !== 250 ? c.spd : null],
      ]);
    case "GATE":
      return eventLine(t, "parked", [
        ["callsign", c.cs],
        ["type", c.type],
        ["stand", c.stand === "*" ? "any" : c.stand],
        ["level", fl(c.rfl)],
        ["route", c.route],
        ["to", c.arr],
        ["airport", c.apt !== airport ? c.apt : null],
      ]);
    case "AUTO":
      return eventLine(t, "autodep", [
        ["callsign", c.cs],
        ["runway", rwy(c.runway)],
        ["when", c.clr ? "cleared" : null],
        ["takeoff", c.full && !c.clr ? "auto" : null],
      ]);
    case "APPR":
      return eventLine(t, "approach", [
        ["callsign", c.cs],
        ["runway", rwy(c.runway)],
      ]);
    case "AUTOLAND":
      return eventLine(t, "autoland", [["callsign", c.cs]]);
    case "CCT":
      return eventLine(t, "circuit", [
        ["callsign", c.cs],
        ["runway", rwy(c.runway)],
        ["side", keyOf(SIDES, c.side)],
        ["type", c.tng ? null : "full-stop"],
        ["join", c.join !== "DW" ? keyOf(JOINS, c.join) : null],
      ]);
    case "CLMB":
      return eventLine(t, "climb", [
        ["callsign", c.cs],
        ["altitude", c.ft],
      ]);
    case "ALT":
    case "SPD":
    case "HDG":
      return eventLine(t, "assign", [
        ["callsign", c.cs],
        [c.kind === "ALT" ? "altitude" : c.kind === "SPD" ? "speed" : "heading", c.value],
      ]);
    case "EMERGENCY":
      return eventLine(t, "emergency", [["callsign", c.cs]]);
    case "COMMENT":
      return `${formatTime(t)} message: text="${c.text.replace(/"/g, "'")}"`;
    case "ROLLOUT":
    case "CMD":
      return null;
  }
}
