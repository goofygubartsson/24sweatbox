/**
 * Parse the hand-maintained files in /data into typed, zod-validated JSON in
 * packages/shared/src/data, which both the server and the web app import.
 *
 *   pnpm data
 *
 * Fails (exit 1) on malformed input; prints warnings for suspicious but usable data.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import config from "../packages/config/src/index";
import {
  AircraftDataSchema,
  AirportSchema,
  CallsignDataSchema,
  FixSchema,
  GroundArtSchema,
  GroundMapSchema,
  OutlinesSchema,
  RunwayPairSchema,
  SectorsSchema,
  MsaSchema,
  SidsSchema,
  type Airport,
  type FixData,
  type GroundArt,
  type GroundMapData,
  type RunwayPairData,
} from "../packages/shared/src/dataTypes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(root, config.data.dir);
const outDir = path.resolve(root, config.data.generatedDir);
const warnings: string[] = [];
const errors: string[] = [];

const read = (rel: string) => fs.readFileSync(path.join(dataDir, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(dataDir, rel));
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l, i) => ({ n: i + 1, t: l.trim() }))
    .filter((l) => l.t !== "" && !l.t.startsWith("#"));

function parseJson<T>(rel: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(read(rel));
  } catch (e) {
    throw new Error(`${rel}: invalid JSON (${(e as Error).message})`);
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.slice(0, 20).map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`${rel}: does not match the expected format\n${issues.join("\n")}`);
  }
  return res.data;
}

/** Split an INI-like text into sections: [name] headers followed by lines. */
function sections(rel: string): Map<string, { n: number; t: string }[]> {
  const out = new Map<string, { n: number; t: string }[]>();
  let current = "";
  for (const l of lines(read(rel))) {
    const m = /^\[([a-z0-9_-]+)\]$/i.exec(l.t);
    if (m) {
      current = m[1]!.toLowerCase();
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (!current) {
      errors.push(`${rel}:${l.n}: line before the first [section]`);
      continue;
    }
    out.get(current)!.push(l);
  }
  return out;
}

const num = (s: string | undefined, where: string): number => {
  const v = Number(s);
  if (s === undefined || !Number.isFinite(v)) {
    errors.push(`${where}: expected a number, got "${s ?? ""}"`);
    return 0;
  }
  return v;
};

// ---- runways ---------------------------------------------------------------------------------------
function buildRunways(): RunwayPairData[] {
  const res: RunwayPairData[] = [];
  for (const l of lines(read("runways.txt"))) {
    const p = l.t.split(/\s+/);
    const where = `runways.txt:${l.n}`;
    if (p.length !== 6) {
      errors.push(`${where}: expected "<name1> <name2> <x1> <y1> <x2> <y2>"`);
      continue;
    }
    const [name1, name2] = p as [string, string];
    const m1 = /^(I[A-Z0-9]{3})-(\d{2}[LCR]?)$/.exec(name1);
    const m2 = /^(I[A-Z0-9]{3})-(\d{2}[LCR]?)$/.exec(name2);
    if (!m1 || !m2 || m1[1] !== m2[1]) {
      errors.push(`${where}: runway names must look like IRFD-07R IRFD-25L (same airport)`);
      continue;
    }
    res.push(
      RunwayPairSchema.parse({
        icao: m1[1],
        name1,
        name2,
        position1: [num(p[2], where), num(p[3], where)],
        position2: [num(p[4], where), num(p[5], where)],
      }),
    );
  }
  return res;
}

// ---- airports --------------------------------------------------------------------------------------
function buildAirports(runways: RunwayPairData[]): Airport[] {
  const Input = z.array(
    AirportSchema.extend({ centre: AirportSchema.shape.centre.optional(), runways: z.array(z.string()).optional() }),
  );
  const input = parseJson("airports.json", Input);
  const seen = new Set<string>();
  const out = input.map((a) => {
    if (seen.has(a.code)) errors.push(`airports.json: duplicate airport ${a.code}`);
    seen.add(a.code);
    const own = runways.filter((r) => r.icao === a.code);
    const pts = own.flatMap((r) => [r.position1, r.position2]);
    const centre: [number, number] | null =
      a.centre ??
      (pts.length
        ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
        : null);
    if (!own.length) warnings.push(`airport ${a.code} has no runways in runways.txt (it will not be drawn)`);
    return AirportSchema.parse({
      ...a,
      centre,
      runways: a.runways ?? own.map((r) => `${r.name1.split("-")[1]}/${r.name2.split("-")[1]}`),
    });
  });
  for (const r of runways)
    if (!seen.has(r.icao)) warnings.push(`runways.txt: ${r.name1} belongs to unknown airport ${r.icao} (ignored)`);
  for (const a of out) {
    for (const t of a.topDowns) if (!seen.has(t)) warnings.push(`airports.json: ${a.code} topDown ${t} is unknown`);
    const designators = a.runways.flatMap((p) => p.split("/"));
    for (const d of a.depRunways) if (!designators.includes(d)) errors.push(`airports.json: ${a.code} departure runway ${d} is not one of its runways`);
  }
  return out;
}

// ---- fixes -----------------------------------------------------------------------------------------
function buildFixes(): FixData[] {
  const s = sections("fixes.txt");
  const out: FixData[] = [];
  const seen = new Map<string, string>();
  for (const layer of ["main", "aeronav", "extra"] as const) {
    for (const l of s.get(layer) ?? []) {
      const p = l.t.split(/\s+/);
      const where = `fixes.txt:${l.n}`;
      if (p.length !== 4) {
        errors.push(`${where}: expected "NAME TYPE X Y"`);
        continue;
      }
      const name = p[0]!.toUpperCase();
      // The legacy app had two overlapping fix tables; the first definition wins.
      if (seen.has(name)) {
        warnings.push(`${where}: duplicate fix ${name} (already in [${seen.get(name)}], ignored)`);
        continue;
      }
      seen.set(name, layer);
      const r = FixSchema.safeParse({ name, type: p[1]!.toUpperCase(), pos: [num(p[2], where), num(p[3], where)], layer });
      if (r.success) out.push(r.data);
      else errors.push(`${where}: ${r.error.issues[0]?.message}`);
    }
  }
  for (const k of s.keys()) if (!["main", "aeronav", "extra"].includes(k)) warnings.push(`fixes.txt: unknown section [${k}]`);
  return out;
}

// ---- aircraft --------------------------------------------------------------------------------------
function buildAircraft() {
  const s = sections("aircraft.txt");
  const types: Record<string, string> = {};
  for (const l of s.get("types") ?? []) {
    const m = /^(.+?)\s*=\s*([A-Z0-9]{2,4})$/i.exec(l.t);
    if (!m) {
      errors.push(`aircraft.txt:${l.n}: expected "Roblox name = ICAO"`);
      continue;
    }
    types[m[1]!.toLowerCase().replace(/\s+cargo$/, "")] = m[2]!.toUpperCase();
  }
  const info: Record<string, { wake: "L" | "M" | "H" | "J"; lengthM: number }> = {};
  for (const l of s.get("info") ?? []) {
    const p = l.t.split(/\s+/);
    if (p.length !== 3 || !/^[LMHJ]$/.test(p[1]!.toUpperCase())) {
      errors.push(`aircraft.txt:${l.n}: expected "ICAO WAKE(L|M|H|J) LENGTH_M"`);
      continue;
    }
    info[p[0]!.toUpperCase()] = { wake: p[1]!.toUpperCase() as "L", lengthM: num(p[2], `aircraft.txt:${l.n}`) };
  }
  for (const icao of new Set(Object.values(types)))
    if (!info[icao]) warnings.push(`aircraft.txt: type ${icao} has no [info] line (wake falls back to the GA rule)`);
  return AircraftDataSchema.parse({ types, info });
}

// ---- callsigns -------------------------------------------------------------------------------------
function buildCallsigns() {
  const s = sections("callsigns.txt");
  const pairs = (sec: string, lower: boolean) => {
    const out: Record<string, string> = {};
    for (const l of s.get(sec) ?? []) {
      const m = /^(.+?)\s*=\s*(.+)$/.exec(l.t);
      if (!m) {
        errors.push(`callsigns.txt:${l.n}: expected "A = B"`);
        continue;
      }
      out[lower ? m[1]!.toLowerCase() : m[1]!.toUpperCase()] = m[2]!.trim().toUpperCase();
    }
    return out;
  };
  return CallsignDataSchema.parse({ spoof: pairs("spoof", true), radio: pairs("radio", false) });
}

// ---- outlines --------------------------------------------------------------------------------------
function buildOutlines() {
  const paths = (rel: string) =>
    lines(read(rel)).map((l) => {
      if (!/^[Mm][\s\d.,eE+-]/.test(l.t)) errors.push(`${rel}:${l.n}: expected an SVG path "d" string starting with M`);
      return l.t;
    });
  return OutlinesSchema.parse({ coast: paths("map-outlines.txt"), airspace: paths("map-airspace.txt") });
}

// ---- ground maps -----------------------------------------------------------------------------------
function buildGround(runways: RunwayPairData[]): Record<string, GroundMapData> {
  const out: Record<string, GroundMapData> = {};
  if (!exists("ground")) return out;
  for (const f of fs.readdirSync(path.join(dataDir, "ground")).filter((f) => f.endsWith(".json")).sort()) {
    const icao = path.basename(f, ".json").toUpperCase();
    const g = parseJson(`ground/${f}`, GroundMapSchema.extend({ icao: z.string().optional() }));
    const map: GroundMapData = { ...g, icao };
    out[icao] = map;
    const graph = map.ground;
    if (!graph) {
      warnings.push(`ground/${f}: no taxi graph yet, so ${icao} is drawn but DEL / GND sweatboxes aren't available there`);
      continue;
    }
    const n = graph.nodes.length;
    const bad = (i: number) => !Number.isInteger(i) || i < 0 || i >= n;
    graph.edges.forEach((e, i) => {
      if (bad(e.a) || bad(e.b)) errors.push(`ground/${f}: edge ${i} references a missing node`);
    });
    for (const h of graph.holds) if (bad(h.n)) errors.push(`ground/${f}: hold ${h.name} references a missing node`);
    for (const e of graph.entries) if (bad(e.n)) errors.push(`ground/${f}: entry on ${e.rwy} references a missing node`);
    for (const s of graph.stands) {
      if (bad(s.n) || bad(s.j)) errors.push(`ground/${f}: stand ${s.name} references a missing node`);
      // stand lead-ins run from the stand (a) to its junction (b)
      else if (!graph.edges.some((e) => e.stand === s.name && e.a === s.n && e.b === s.j))
        warnings.push(`ground/${f}: stand ${s.name} has no lead-in edge from its node ${s.n} to junction ${s.j}`);
    }
    // ground-map runway strings ("07C/25C") should match a runway pair in either order
    const pairs = runways
      .filter((r) => r.icao === icao)
      .map((r) => new Set([r.name1.split("-")[1], r.name2.split("-")[1]]));
    const known = (rwy: string) => {
      const [a, b] = rwy.split("/");
      return pairs.some((p) => p.has(a) && p.has(b));
    };
    for (const h of graph.holds)
      if (!known(h.rwy)) warnings.push(`ground/${f}: hold ${h.name} is on unknown runway ${h.rwy}`);
    for (const e of graph.entries)
      if (!known(e.rwy)) warnings.push(`ground/${f}: entry node ${e.n} is on unknown runway ${e.rwy}`);
    graph.edges.forEach((e, i) => {
      if (e.crossing && !known(e.crossing)) warnings.push(`ground/${f}: edge ${i} crosses unknown runway ${e.crossing}`);
    });
  }
  return out;
}

function buildGroundArt(): Record<string, GroundArt> {
  const out: Record<string, GroundArt> = {};
  if (!exists("ground-art")) return out;
  for (const f of fs.readdirSync(path.join(dataDir, "ground-art")).filter((f) => f.endsWith(".json")).sort())
    out[path.basename(f, ".json").toUpperCase()] = parseJson(`ground-art/${f}`, GroundArtSchema);
  return out;
}

// ---- SIDs ------------------------------------------------------------------------------------------
function checkSids(sids: z.infer<typeof SidsSchema>, fixes: FixData[], airports: Airport[]) {
  const names = new Set(fixes.map((f) => f.name));
  for (const [apt, table] of Object.entries(sids)) {
    if (!airports.some((a) => a.code === apt)) warnings.push(`sids.json: unknown airport ${apt}`);
    for (const [token, byRwy] of Object.entries(table))
      for (const [rwy, list] of Object.entries(byRwy))
        for (const fix of list)
          if (!names.has(fix)) warnings.push(`sids.json: ${apt} ${token} ${rwy}: unknown fix ${fix}`);
  }
}

// ---- minimum safe altitudes ---------------------------------------------------------------------------
function buildMsa() {
  const { areas } = parseJson("msa.json", MsaSchema.passthrough());
  for (const [i, a] of areas.entries()) if (!airportsSeen.has(a.airport)) warnings.push(`msa.json: area ${i} has unknown airport ${a.airport}`);
  return areas;
}
const airportsSeen = new Set<string>();

// ---- main ------------------------------------------------------------------------------------------
function main() {
  let result: Record<string, unknown>;
  try {
    const runways = buildRunways();
    const airports = buildAirports(runways);
    for (const a of airports) airportsSeen.add(a.code);
    const fixes = buildFixes();
    const sids = parseJson("sids.json", SidsSchema);
    checkSids(sids, fixes, airports);
    result = {
      airports,
      runways: runways.filter((r) => airports.some((a) => a.code === r.icao)),
      fixes,
      sids,
      aircraft: buildAircraft(),
      callsigns: buildCallsigns(),
      outlines: buildOutlines(),
      sectors: parseJson("sectors.json", SectorsSchema),
      msa: buildMsa(),
      ground: buildGround(runways),
      groundArt: buildGroundArt(),
    };
  } catch (e) {
    console.error(`build-data: ${(e as Error).message}`);
    process.exit(1);
  }
  if (errors.length) {
    console.error(`build-data: ${errors.length} error(s)\n${errors.map((e) => "  " + e).join("\n")}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(result)) {
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(value));
    counts[name] = Array.isArray(value) ? value.length : Object.keys(value as object).length;
  }
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ builtAt: new Date().toISOString(), counts, warnings }, null, 1),
  );
  const summary = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`build-data: wrote ${path.relative(root, outDir)} (${summary})`);
  if (warnings.length && process.env.BUILD_DATA_VERBOSE)
    console.log(warnings.map((w) => "  warning: " + w).join("\n"));
  else if (warnings.length) console.log(`build-data: ${warnings.length} warning(s); set BUILD_DATA_VERBOSE=1 to list them`);
}

main();
