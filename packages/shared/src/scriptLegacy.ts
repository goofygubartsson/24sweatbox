// One-way converter from the old sweatbox line layout ("<seconds> <COMMAND> <args…>") to the
// current [sweatbox] file. The loader no longer reads the old layout; `pnpm sbx:convert` uses this.
import {
  acType,
  airportCode,
  callsign,
  coord,
  fail,
  formatCommand,
  formatHeader,
  int,
  level,
  LineError,
  runwayName,
  validateRoute,
  type CommandInput,
  type JoinLeg,
  type RolloutMode,
  type ScopeView,
  type ScriptHeader,
} from "./script";

const STAND_RE = /^(I[A-Z0-9]{3})-([A-Z0-9]+|\*)$/;

function need(args: string[], kw: string, min: number, max = min): void {
  if (args.length < min || args.length > max) fail(`${kw} needs ${min === max ? min : `${min}-${max}`} arguments`);
}

/** One old line as a command (or a client command line for CMD). */
function oldCommand(kw: string, args: string[], rest: string): CommandInput | null {
  const o = 0;
  switch (kw) {
    case "SPAWN":
      need(args, kw, 10);
      return {
        kind: "SPAWN",
        offset: o,
        cs: callsign(args[0]),
        type: acType(args[1]),
        alt: int(args[2], "altitude", 0, 99999),
        rfl: level(args[3]),
        gs: int(args[4], "speed", 1, 2000),
        route: validateRoute(args[5]),
        dep: airportCode(args[6]),
        arr: airportCode(args[7]),
        x: coord(args[8]),
        y: coord(args[9]),
      };
    case "DEP":
      need(args, kw, 7, 8);
      return {
        kind: "DEP",
        offset: o,
        cs: callsign(args[0]),
        type: acType(args[1]),
        runway: runwayName(args[2]),
        climb: int(args[3], "climb", 0, 99999),
        rfl: level(args[4]),
        route: validateRoute(args[5]),
        arr: airportCode(args[6]),
        spd: args[7] === undefined ? 250 : int(args[7], "speed", 1, 2000),
      };
    case "GATE":
    case "STAND": {
      need(args, kw, 6);
      const m = STAND_RE.exec((args[2] ?? "").toUpperCase());
      if (!m) fail(`invalid stand "${args[2] ?? ""}"`);
      return { kind: "GATE", offset: o, cs: callsign(args[0]), type: acType(args[1]), apt: m![1]!, stand: m![2]!, rfl: level(args[3]), route: validateRoute(args[4]), arr: airportCode(args[5]) };
    }
    case "AUTO":
      need(args, kw, 2, 3);
      return null; // automatic departures are gone: dropped (with a note)
    case "APPR":
      need(args, kw, 2);
      return { kind: "APPR", offset: o, cs: callsign(args[0]), runway: runwayName(args[1]) };
    case "CCT": {
      need(args, kw, 3, 5);
      const side = (args[2] ?? "").toUpperCase();
      if (side !== "L" && side !== "R") fail("CCT side must be L or R");
      let tng = true;
      let join: JoinLeg = "DW";
      for (const opt of args.slice(3).map((a) => a.toUpperCase())) {
        if (opt === "TG" || opt === "FS") tng = opt === "TG";
        else if (["DW", "BASE", "UP", "CROSS", "DOWN"].includes(opt)) join = opt as JoinLeg;
        else fail(`invalid CCT option "${opt}"`);
      }
      return { kind: "CCT", offset: o, cs: callsign(args[0]), runway: runwayName(args[1]), side: side as "L" | "R", tng, join };
    }
    case "CLMB":
      need(args, kw, 2);
      return { kind: "CLMB", offset: o, cs: callsign(args[0]), ft: int(args[1], "altitude", 0, 99999) };
    case "ROLLOUT": {
      need(args, kw, 1);
      const mode = (args[0] ?? "").toUpperCase();
      if (mode !== "OFF" && mode !== "HOLD" && mode !== "STAND") fail("ROLLOUT must be OFF, HOLD or STAND");
      return { kind: "ROLLOUT", offset: o, mode: mode as RolloutMode };
    }
    case "ALT":
    case "SPD":
    case "HDG":
      need(args, kw, 2);
      return { kind: kw, offset: o, cs: callsign(args[0]), value: int(args[1], "value", 0, 99999) };
    case "EMERGENCY":
      need(args, kw, 1);
      return { kind: "EMERGENCY", offset: o, cs: callsign(args[0]) };
    case "COMMENT":
      return { kind: "COMMENT", offset: o, text: rest.trim() };
    case "CMD":
      return { kind: "CMD", offset: o, text: rest.trim() };
    default:
      return fail(`unknown command "${kw}"`);
  }
}

export interface Converted {
  text: string;
  /** Things that could not be carried over (each also left as a "#" comment in the file). */
  notes: string[];
}

/** Convert an old-layout file. Throws an Error listing the lines it could not read. */
export function convertLegacyScript(text: string, name?: string): Converted {
  const commands: CommandInput[] = [];
  const dropped: string[] = [];
  const errors: string[] = [];
  const comments: string[] = [];
  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((rawLine, i) => {
      const raw = rawLine.trim();
      if (raw === "") return;
      if (raw.startsWith("#")) {
        comments.push(raw);
        return;
      }
      const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(raw);
      try {
        if (!m || !/^\d+(\.\d+)?$/.test(m[1]!)) fail(`not an old-format line`);
        const rest = m![3] ?? "";
        const c = oldCommand(m![2]!.toUpperCase(), rest.trim() === "" ? [] : rest.trim().split(/\s+/), rest);
        if (c) commands.push({ ...c, offset: Math.round(Number(m![1])) });
        else if (m![2]!.toUpperCase() === "AUTO") dropped.push(`dropped "${raw}" (automatic departures are no longer part of the sim)`);
      } catch (e) {
        if (!(e instanceof LineError)) throw e;
        errors.push(`Line ${i + 1}: ${e.message}`);
      }
    });
  if (errors.length) throw new Error(errors.join("\n"));
  commands.sort((a, b) => a.offset - b.offset);

  // the header: scope view and runways from the CMD lines at the start, after landing from ROLLOUT
  const notes: string[] = [...dropped];
  let airport: string | null = null;
  let view: ScopeView = "CTR";
  let dep: string | null = null;
  let arr: string[] = [];
  let after: RolloutMode | null = null;
  const events: CommandInput[] = [];
  for (const c of commands) {
    if (c.kind === "CMD") {
      const ld = /^LDARPT\s+(I[A-Z0-9]{3})(?:\s+(CTR|GND|TWR))?$/i.exec(c.text);
      const rc = /^RWYCFG\s+(I[A-Z0-9]{3})\s+(\S+)\s+(\S+)$/i.exec(c.text);
      if (ld && c.offset === 0) {
        airport = ld[1]!.toUpperCase();
        view = (ld[2]?.toUpperCase() ?? "CTR") as ScopeView;
      } else if (rc && c.offset === 0) {
        airport ??= rc[1]!.toUpperCase();
        dep = rc[2]!.toUpperCase();
        arr = rc[3]!.toUpperCase().split(",");
      } else notes.push(`dropped "${c.offset} CMD ${c.text}" (scope commands are now the [sweatbox] settings)`);
      continue;
    }
    if (c.kind === "ROLLOUT") {
      if (after && c.offset > 0) notes.push(`dropped a later "ROLLOUT ${c.mode}" (after landing is one setting)`);
      else after = c.mode;
      continue;
    }
    events.push(c);
  }
  // no LDARPT: the airport of the first stand / runway / destination
  if (!airport) {
    for (const c of events) {
      airport =
        c.kind === "GATE" ? c.apt : c.kind === "DEP" || c.kind === "APPR" || c.kind === "CCT" ? c.runway.split("-")[0]! : c.kind === "SPAWN" ? c.arr : null;
      if (airport) break;
    }
  }
  if (!airport) throw new Error("can't tell which airport this file is for (no LDARPT, stand or runway)");
  const header: ScriptHeader = { name: name ?? null, airport, view, depRunway: dep, arrRunways: arr, afterLanding: after };
  const lines = [
    ...comments,
    ...(comments.length ? [""] : []),
    ...formatHeader(header),
    "",
    ...notes.map((n) => `# ${n}`),
    ...events.map((c) => formatCommand(c, airport!)).filter((l): l is string => l !== null),
  ];
  return { text: lines.join("\n") + "\n", notes };
}
