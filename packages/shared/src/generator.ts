// Sweatbox generator: Airport + Position + Runway format -> a ready-to-load .sbx script.
// The server uses it for "Create Sweatbox" / "Load sweatbox"; the Maker uses it as a starting point
// that trainers can edit.
import { z } from "zod";
import cfg from "@sweatbox/config/public";
import { add, aviationAngle, bearing, dot, fromAviationAngle, lerp, perp, scale, sub, type Vec } from "./geometry";
import { appr, findRunwayEnd, rwyEnd } from "./runways";
import { airportRef, airports, getAirport, runwaysOf } from "./world";
import { getGroundGraph } from "./ground";
import { airlineCodes } from "./callsigns";
import { fixRouteBetween } from "./routes";
import { eventLine, formatCommand, formatHeader, type CommandInput, type RolloutMode, type ScopeView } from "./script";
import { heading3 } from "./format";
import type { Airport } from "./dataTypes";

const G = cfg.generator;
const U = cfg.sim.unitsPerNm;

export const POSITIONS = ["DEL", "GND", "TWR", "APP", "CTR"] as const;
export type Position = (typeof POSITIONS)[number];

export const TRAFFIC_LEVELS = ["light", "normal", "heavy"] as const;
export type TrafficLevel = (typeof TRAFFIC_LEVELS)[number];

/** DEL and GND sweatboxes start with parked aircraft, so they need the airport's ground map. */
export const needsGroundMap = (p: Position): boolean => p === "DEL" || p === "GND";

export class GeneratorError extends Error {
  /** bad_input: unknown airport / runway; unavailable: valid, but not possible at this airport. */
  constructor(
    message: string,
    readonly kind: "bad_input" | "unavailable" = "bad_input",
  ) {
    super(message);
  }
}

// ---- runway formats --------------------------------------------------------------------------------

export interface RunwayFormat {
  /** Runway number in use, e.g. "25". */
  id: string;
  /** "25L / 25C / 25R" */
  label: string;
  /** Departure runway designator. */
  dep: string;
  /** Arrival runway designators. */
  arr: string[];
}

const SUFFIX_ORDER: Record<string, number> = { L: 0, C: 1, R: 2 };

/** One format per runway number: IRFD gives "07" (07L/07C/07R) and "25" (25L/25C/25R). */
export function runwayFormats(apt: string): RunwayFormat[] {
  const main = getAirport(apt)?.depRunways ?? [];
  const groups = new Map<string, string[]>();
  for (const r of runwaysOf(apt))
    for (const name of [r.name1, r.name2]) {
      const d = name.split("-")[1]!;
      groups.set(d.slice(0, 2), [...(groups.get(d.slice(0, 2)) ?? []), d]);
    }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, list]) => {
      const des = [...list].sort((a, b) => (SUFFIX_ORDER[a.slice(2)] ?? 3) - (SUFFIX_ORDER[b.slice(2)] ?? 3));
      // parallel runways: depart from the airport's main departure runway (else the right-hand one),
      // land on the others
      const dep = des.find((d) => main.includes(d)) ?? des.find((d) => d.endsWith("R")) ?? des[des.length - 1]!;
      const arr = des.length > 1 ? des.filter((d) => d !== dep) : [dep];
      return { id, label: des.join(" / "), dep, arr };
    });
}

/** Airports a sweatbox can be generated for (they have runways). */
export function generatorAirports(): Airport[] {
  return airports.filter((a) => runwaysOf(a.code).length > 0);
}

// ---- traffic items ---------------------------------------------------------------------------------

export const KINDS = {
  "dep-stand": "Departure from a stand",
  "dep-air": "Departure, airborne",
  "arr-final": "Arrival on final",
  inbound: "Inbound",
  "cct-ga": "Circuit (GA)",
} as const;
export type Kind = keyof typeof KINDS;

export const ItemSchema = z.object({
  id: z.string(),
  time: z.number().int().min(0).max(86400),
  kind: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]),
  cs: z.string().max(12),
  type: z.string().max(5),
  stand: z.string().max(12).default(""),
  runway: z.string().max(4).default(""),
  climb: z.number().int().min(0).max(99999).default(G.departureClimbFt),
  rfl: z.string().max(5).default(G.cruiseLevels[0]!),
  route: z.string().max(200).default("HDG360"),
  dep: z.string().max(4).default(""),
  arr: z.string().max(4).default(""),
  alt: z.number().int().min(0).max(99999).default(G.inboundAltFt[0]),
  gs: z.number().int().min(1).max(2000).default(G.inboundSpeedKt),
  x: z.number().default(0),
  y: z.number().default(0),
  distNm: z.number().min(1).max(40).default(G.finalNm[0]!),
  side: z.enum(["L", "R"]).default("L"),
  tng: z.boolean().default(true),
});
export type SweatboxItem = z.infer<typeof ItemSchema>;

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
let idSeq = 0;
export const newItemId = (): string => `i${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function randomCallsign(ga: boolean, used: ReadonlySet<string>): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ".split("");
  for (let i = 0; i < 200; i++) {
    const cs = ga
      ? `N${100 + Math.floor(Math.random() * 900)}${pick(letters)}${pick(letters)}`
      : `${pick(airlineCodes())}${10 + Math.floor(Math.random() * (Math.random() < 0.5 ? 990 : 9990))}`;
    if (!used.has(cs)) return cs;
  }
  return `SBX${used.size + 1}`;
}

/** Another airport with runways (destination / origin of generated traffic). */
function otherAirport(apt: string): string {
  const others = generatorAirports().filter((a) => a.code !== apt);
  return others.length ? pick(others).code : apt;
}

const headingRoute = (h: number) => `HDG${heading3(h)}`;

/** A stand with nobody on it at `time`, or null. */
function freeStand(apt: string, items: readonly SweatboxItem[], time: number): string | null {
  const g = getGroundGraph(apt);
  if (!g) return null;
  const parked = items.filter((i) => (i.kind === "dep-stand" || i.kind === "cct-ga") && i.stand);
  const stand = g.stands.find((s) => !parked.some((i) => i.stand === s.name && time >= i.time));
  return stand?.name ?? null;
}

/** Circuit side for a runway: away from the airport's other runways (left-hand when there are none). */
function circuitSide(apt: string, designator: string): "L" | "R" {
  const end = findRunwayEnd(`${apt}-${designator}`);
  if (!end) return "L";
  const g = rwyEnd(end);
  const right = perp(g.dir); // map y points south, so this is the right-hand side
  const others = runwaysOf(apt).filter((r) => r.name1 !== end.name && r.name2 !== end.name);
  const offset = others.reduce((sum, r) => sum + dot(sub(lerp(r.position1, r.position2, 0.5), g.start), right), 0);
  return offset < 0 ? "R" : "L"; // the other runways on the left: right-hand circuits
}

/** Inbound spawn point on the approach side of the airport, heading straight for it. */
function inboundStart(apt: string, arrRunway: string): { pos: Vec; heading: number } {
  const ref = airportRef(apt) ?? { x: 0, y: 0 };
  const end = findRunwayEnd(`${apt}-${arrRunway}`);
  const outBearing = end ? aviationAngle(appr(end).out) : Math.random() * 360;
  const inside = (p: Vec) => Math.abs(p.x) <= G.mapLimitUnits && Math.abs(p.y) <= G.mapLimitUnits;
  for (let i = 0; i < 40; i++) {
    const p = add(ref, fromAviationAngle(outBearing + between(-G.inboundSpreadDeg, G.inboundSpreadDeg), between(G.inboundNm[0], G.inboundNm[1]) * U));
    if (inside(p)) return { pos: p, heading: bearing(p, ref) };
  }
  // near the map edge: come in from closer
  const p = add(ref, fromAviationAngle(outBearing, G.inboundNm[0] * U * 0.5));
  return { pos: { x: Math.max(-G.mapLimitUnits, Math.min(G.mapLimitUnits, p.x)), y: Math.max(-G.mapLimitUnits, Math.min(G.mapLimitUnits, p.y)) }, heading: bearing(p, ref) };
}

export interface ItemContext {
  apt: string;
  position: Position;
  format: RunwayFormat;
  items: readonly SweatboxItem[];
  /** Departures take the next stand that frees up ("*") instead of a stand free right now. */
  anyStand?: boolean;
}

/** Positions that start with every stand occupied (DEL / GND). */
export const fillsStands = (p: Position): boolean => (G.fillStands as readonly string[]).includes(p);

/** One new aircraft of this kind, or null when it doesn't fit (no free stand, no ground map). */
export function makeItem(ctx: ItemContext, kind: Kind, time: number, arrRunway?: string): SweatboxItem | null {
  const { apt, format, items } = ctx;
  const used = new Set(items.map((i) => i.cs));
  const ga = kind === "cct-ga";
  const base = { id: newItemId(), time, kind, cs: randomCallsign(ga, used), type: pick(ga ? G.gaTypes : G.airlinerTypes) };
  const ref = airportRef(apt);
  // departures fly published fixes toward their destination (then land there and are removed)
  const routeTo = (from: Vec, dest: string) => {
    const fixes = fixRouteBetween(apt, dest);
    if (fixes) return fixes;
    const r = airportRef(dest);
    return r && ref ? headingRoute(bearing(from, r)) : headingRoute(360);
  };
  switch (kind) {
    case "dep-stand": {
      const stand = ctx.anyStand && getGroundGraph(apt) ? "*" : freeStand(apt, items, time);
      if (!stand || !ref) return null;
      const arr = otherAirport(apt);
      return ItemSchema.parse({ ...base, stand, runway: format.dep, route: routeTo(ref, arr), arr, dep: apt, rfl: pick(G.cruiseLevels) });
    }
    case "dep-air": {
      const end = findRunwayEnd(`${apt}-${format.dep}`);
      if (!end) return null;
      const arr = otherAirport(apt);
      return ItemSchema.parse({ ...base, runway: format.dep, route: routeTo(rwyEnd(end).end, arr), arr, dep: apt, rfl: pick(G.cruiseLevels) });
    }
    case "arr-final":
      return ItemSchema.parse({ ...base, runway: arrRunway ?? format.arr[0]!, dep: otherAirport(apt), arr: apt, distNm: pick(G.finalNm), gs: G.finalSpeedKt });
    case "inbound": {
      const start = inboundStart(apt, arrRunway ?? format.arr[0]!);
      const [lo, hi] = G.inboundAltFt;
      const alt = Math.round(between(lo, hi) / 1000) * 1000;
      return ItemSchema.parse({
        ...base,
        dep: otherAirport(apt),
        arr: apt,
        alt,
        gs: G.inboundSpeedKt,
        route: headingRoute(start.heading),
        x: round5(start.pos.x),
        y: round5(start.pos.y),
        rfl: pick(G.cruiseLevels),
      });
    }
    case "cct-ga": {
      const stand = freeStand(apt, items, time);
      if (!stand) return null;
      return ItemSchema.parse({ ...base, stand, runway: format.dep, dep: apt, arr: apt, rfl: "010", route: "CCT", side: circuitSide(apt, format.dep), tng: true });
    }
  }
}

// ---- whole sweatboxes ------------------------------------------------------------------------------

export interface SweatboxSettings {
  apt: string;
  position: Position;
  /** Runway format id, e.g. "25". */
  runway: string;
  level?: TrafficLevel;
  durationMin?: number;
}

export interface SweatboxPlan {
  name: string;
  apt: string;
  position: Position;
  format: RunwayFormat;
  rollout: RolloutMode;
  items: SweatboxItem[];
}

const MIX: Record<Position, Kind[]> = {
  DEL: ["dep-stand"],
  GND: ["dep-stand", "dep-stand", "dep-stand", "arr-final"],
  TWR: ["arr-final"], // the departures are the aircraft parked on every stand (see planSweatbox)
  APP: ["inbound", "inbound", "dep-air"],
  CTR: ["inbound", "dep-air"],
};

/** Check the settings; throws GeneratorError with a message for the trainer. */
export function resolveSettings(s: SweatboxSettings): { airport: Airport; format: RunwayFormat; ground: boolean } {
  const airport = getAirport(s.apt);
  if (!airport) throw new GeneratorError(`Unknown airport ${s.apt}`);
  const format = runwayFormats(airport.code).find((f) => f.id === s.runway);
  if (!format) throw new GeneratorError(runwaysOf(airport.code).length ? `${airport.code} has no runway ${s.runway}` : `${airport.code} has no runways yet`);
  const ground = Boolean(getGroundGraph(airport.code));
  if (needsGroundMap(s.position) && !ground)
    throw new GeneratorError(`${airport.code} has no ground map yet, so ${s.position} sweatboxes aren't available there`, "unavailable");
  return { airport, format, ground };
}

export function rolloutFor(position: Position, ground: boolean): RolloutMode {
  if (!ground) return "OFF";
  return position === "GND" ? "HOLD" : position === "TWR" ? "STAND" : "OFF";
}

export function planSweatbox(s: SweatboxSettings): SweatboxPlan {
  const { airport, format, ground } = resolveSettings(s);
  const level = s.level ?? G.defaultLevel;
  const duration = s.durationMin ?? G.durationMin;
  const n = Math.max(1, Math.round(duration * G.perMinute[level] * G.rateByPosition[s.position]));
  const items: SweatboxItem[] = [];
  const fill = ground && fillsStands(s.position);
  const twr = s.position === "TWR";
  // every stand starts occupied (TWR: a few of them are GA circuit flights)
  if (fill) {
    const ctx = { apt: airport.code, position: s.position, format, items };
    for (let k = 0; twr && k < G.twrCircuitAircraft; k++) {
      const it = makeItem(ctx, "cct-ga", 0);
      if (it) items.push(it);
    }
    for (let k = items.length; k < (getGroundGraph(airport.code)?.stands.length ?? 0); k++) {
      const it = makeItem(ctx, "dep-stand", 0);
      if (it) items.push(it);
    }
  }
  let arrivals = 0;
  // arrivals on final: landings on one runway far enough apart that they never lose separation
  // (sim movement is gs / 3600 map units a second, and they slow to approach speed on short final)
  const gapSec = Math.ceil((G.arrivalSpacingNm * U * 3600) / cfg.sim.approachSpeedKt);
  const nextLanding = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const t = Math.round((i * duration * 60) / n);
    let kind = MIX[s.position][i % MIX[s.position].length]!;
    // without a ground map nothing can be parked (TWR never spawns aircraft on the runway)
    if (!ground && kind === "dep-stand") kind = twr ? "arr-final" : "dep-air";
    if (!ground && kind === "cct-ga") kind = "arr-final";
    const arrRunway = format.arr[arrivals % format.arr.length]!;
    if (kind === "arr-final" || kind === "inbound") arrivals++;
    const it = makeItem({ apt: airport.code, position: s.position, format, items, anyStand: fill }, kind, t, arrRunway);
    if (it?.kind === "arr-final") {
      // busy ground positions get their arrivals from the shortest final
      if (fill) it.distNm = G.finalNm[0]!;
      const flight = Math.round((it.distNm * U * 3600) / it.gs);
      it.time = Math.max(it.time, (nextLanding.get(it.runway) ?? 0) - flight);
      if (it.time > duration * 60) continue;
      nextLanding.set(it.runway, it.time + flight + gapSec);
    }
    if (it) items.push(it);
  }
  return { name: `${s.position}-${airport.code}-${format.id}`, apt: airport.code, position: s.position, format, rollout: rolloutFor(s.position, ground), items };
}

const viewFor = (p: Position): ScopeView => (p === "GND" || p === "DEL" ? "GND" : p === "TWR" ? "TWR" : "CTR");

/** Glidepath altitude at `nm` from the threshold (same formula as the sim). */
export const glideAltitudeFt = (nm: number): number => Math.max(nm, 0) * cfg.sim.ftPerNm * Math.tan((cfg.sim.glideslopeDeg * Math.PI) / 180);

function itemLines(apt: string, it: SweatboxItem): string[] {
  const t = it.time;
  const rwy = `${apt}-${it.runway}`;
  const c = (cmd: CommandInput) => formatCommand(cmd, apt)!;
  switch (it.kind) {
    case "dep-stand":
      return [
        eventLine(t, "parked", [
          ["callsign", it.cs],
          ["type", it.type],
          ["stand", it.stand === "*" ? "any" : it.stand],
          ["level", `FL${it.rfl}`],
          ["route", it.route],
          ["to", it.arr],
          ["climb", it.climb],
        ]),
      ];
    case "dep-air":
      return [c({ kind: "DEP", offset: t, cs: it.cs, type: it.type, runway: rwy, climb: it.climb, rfl: it.rfl, route: it.route, arr: it.arr, spd: cfg.sim.defaultDepSpeedKt })];
    case "arr-final": {
      const end = findRunwayEnd(rwy);
      if (!end) return [];
      const a = appr(end);
      const p = add(a.threshold, scale(a.out, it.distNm * U));
      return [
        c({ kind: "SPAWN", offset: t, cs: it.cs, type: it.type, alt: Math.round(glideAltitudeFt(it.distNm) / 100) * 100, rfl: it.rfl, gs: it.gs, route: headingRoute(a.course), dep: it.dep, arr: apt, x: round5(p.x), y: round5(p.y) }),
        c({ kind: "APPR", offset: t, cs: it.cs, runway: rwy }), // same second: established from the start
      ];
    }
    case "inbound":
      return [c({ kind: "SPAWN", offset: t, cs: it.cs, type: it.type, alt: it.alt, rfl: it.rfl, gs: it.gs, route: it.route, dep: it.dep, arr: it.arr, x: it.x, y: it.y })];
    case "cct-ga":
      return [
        c({ kind: "GATE", offset: t, cs: it.cs, type: it.type, apt, stand: it.stand, rfl: "010", route: "CCT", arr: apt }),
        c({ kind: "CCT", offset: t, cs: it.cs, runway: rwy, side: it.side, tng: it.tng, join: "UP" }),
      ];
  }
}

export interface GeneratedScript {
  text: string;
  /** script line number (1-based) -> item id */
  lineItem: Map<number, string>;
}

/** The .sbx text for a plan. */
export function sweatboxScript(plan: Pick<SweatboxPlan, "name" | "apt" | "position" | "format" | "rollout" | "items">): GeneratedScript {
  const lines = [
    `# ${cfg.app.name}: ${plan.position} at ${plan.apt}, runway ${plan.format.label}`,
    ...formatHeader({
      name: plan.name,
      airport: plan.apt,
      position: plan.position,
      view: viewFor(plan.position),
      depRunway: plan.format.dep,
      arrRunways: plan.format.arr,
      afterLanding: plan.rollout,
    }),
    "",
  ];
  const lineItem = new Map<number, string>();
  for (const it of [...plan.items].sort((a, b) => a.time - b.time))
    for (const l of itemLines(plan.apt, it)) {
      lines.push(l);
      lineItem.set(lines.length, it.id);
    }
  return { text: lines.join("\n") + "\n", lineItem };
}

/** Settings -> ready-to-load script. Throws GeneratorError for impossible settings. */
export function generateSweatbox(s: SweatboxSettings): { name: string; text: string; aircraft: number } {
  const plan = planSweatbox(s);
  return { name: plan.name, text: sweatboxScript(plan).text, aircraft: plan.items.length };
}
