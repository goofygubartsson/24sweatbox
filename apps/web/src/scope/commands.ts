// Scope command line (spec 10). Typed with or without a leading "."; "." + letters opens autocomplete.
import { findRunwayEnd, getAirport, runwaysOf } from "@sweatbox/shared";
import { api, ApiError } from "../lib/api";
import type { ScopeHandle } from "./ScopeView";
import { saveRwyCfg, useScope, type WidgetKind } from "./store";
import { switchView } from "./views";
import type { ViewMode } from "./model";

export interface CommandContext {
  isHost: boolean;
  code: string | null;
  scope: ScopeHandle | null;
  /** SBLOAD without a name: load the clipboard as a script. */
  loadClipboard: () => Promise<void>;
  /** True when run from a script CMD broadcast. */
  fromScript?: boolean;
}

export interface CommandDef {
  name: string;
  aliases: string[];
  args: string;
  desc: string;
  host?: boolean;
  run: (args: string[], ctx: CommandContext) => void | Promise<void>;
}

const say = (t: string, level: "local" | "error-local" = "local") => useScope.getState().say(t, level);

function openWidget(kind: WidgetKind) {
  const st = useScope.getState();
  if (!st.widgets.some((w) => w.id === kind)) st.set({ widgets: [...st.widgets, { id: kind, kind }] });
}

function requireSession(ctx: CommandContext): string {
  if (!ctx.code) throw new Error("No session: this command needs a sweatbox session");
  return ctx.code;
}

function findCs(cs: string | undefined) {
  if (!cs) throw new Error("Give a callsign");
  const a = useScope.getState().aircraft.find((x) => x.callsign === cs.toUpperCase());
  if (!a) throw new Error(`No aircraft ${cs.toUpperCase()}`);
  return a;
}

export const COMMANDS: CommandDef[] = [
  {
    name: "LDARPT",
    aliases: [],
    args: "ICAO [CTR|GND|TWR|AIR]",
    desc: "Load an airport and view",
    run: async ([icao, view], ctx) => {
      if (!icao) throw new Error("LDARPT needs an airport, e.g. LDARPT IRFD TWR");
      const v = (view ?? "CTR").toUpperCase();
      const mode: ViewMode = v === "AIR" ? "CTR" : (v as ViewMode);
      if (!["CTR", "GND", "TWR"].includes(mode)) throw new Error("View is CTR, GND, TWR or AIR");
      const err = switchView(icao.toUpperCase(), mode, ctx.scope);
      if (err) throw new Error(err);
      // opening the TWR view as host turns TWR mode on in the session
      if (mode === "TWR" && ctx.isHost && ctx.code && !ctx.fromScript && !useScope.getState().snap?.twr) await api.twr(ctx.code, true);
    },
  },
  {
    name: "RWYCFG",
    aliases: [],
    args: "ICAO DEP ARR | ICAO DISABLE | RESET",
    desc: "Runway config: centrelines, list filters and defaults",
    run: ([icao, dep, arr]) => {
      const st = useScope.getState();
      if (!icao) throw new Error("RWYCFG ICAO DEP ARR (comma lists), RWYCFG ICAO DISABLE or RWYCFG RESET");
      if (icao.toUpperCase() === "RESET") {
        saveRwyCfg({});
        st.set({ rwycfg: {} });
        return say("Runway config reset");
      }
      const apt = getAirport(icao);
      if (!apt) throw new Error(`Unknown airport ${icao.toUpperCase()}`);
      if (dep?.toUpperCase() === "DISABLE") {
        const r = { ...st.rwycfg, [apt.code]: "disabled" as const };
        saveRwyCfg(r);
        st.set({ rwycfg: r });
        return say(`${apt.code} runway config disabled`);
      }
      const list = (s: string | undefined) => (s ? s.toUpperCase().split(",").filter(Boolean) : []);
      const deps = list(dep);
      const arrs = list(arr);
      for (const d of [...deps, ...arrs]) if (!findRunwayEnd(`${apt.code}-${d}`)) throw new Error(`Unknown runway ${apt.code}-${d}`);
      const r = { ...st.rwycfg, [apt.code]: { dep: deps, arr: arrs } };
      saveRwyCfg(r);
      st.set({ rwycfg: r });
      say(`${apt.code} DEP ${deps.join(",") || "-"} ARR ${arrs.join(",") || "-"}`);
    },
  },
  {
    name: "//",
    aliases: [],
    args: "CALLSIGN",
    desc: "Assume / release an aircraft",
    run: ([cs]) => {
      const a = findCs(cs);
      say(`${a.callsign} ${useScope.getState().toggleAssumed(a.callsign) ? "assumed" : "released"}`);
    },
  },
  {
    name: "FIXES",
    aliases: [],
    args: "",
    desc: "Always show fixes",
    run: () => {
      const st = useScope.getState();
      st.set({ fixesAlways: !st.fixesAlways });
      say(`Fixes ${!st.fixesAlways ? "always shown" : "shown when zoomed in"}`);
    },
  },
  {
    name: "MSA",
    aliases: [],
    args: "",
    desc: "Show / hide the minimum safe altitudes",
    run: () => {
      const st = useScope.getState();
      st.set({ msa: !st.msa });
      say(`Minimum safe altitudes ${!st.msa ? "shown" : "hidden"}`);
    },
  },
  { name: "QF", aliases: ["FPL"], args: "", desc: "Flight plan readout", run: () => openWidget("qf") },
  {
    name: "C",
    aliases: [],
    args: "",
    desc: "Copy the map coordinates under the cursor",
    run: async (_a, ctx) => {
      const p = ctx.scope?.mouseWorld();
      if (!p) throw new Error("Move the mouse over the scope first");
      const text = `${p.x.toFixed(5)} ${p.y.toFixed(5)}`;
      try {
        await navigator.clipboard.writeText(text);
        say(`Copied ${text}`);
      } catch {
        say(`Coordinates: ${text} (clipboard blocked)`);
      }
    },
  },
  {
    name: "SBPLAY",
    aliases: [],
    args: "",
    desc: "Play the sweatbox clock",
    host: true,
    run: async (_a, ctx) => void (await api.clock(requireSession(ctx), { action: "play" })),
  },
  {
    name: "SBPAUSE",
    aliases: [],
    args: "",
    desc: "Pause the sweatbox clock",
    host: true,
    run: async (_a, ctx) => void (await api.clock(requireSession(ctx), { action: "pause" })),
  },
  {
    name: "SBSPEED",
    aliases: [],
    args: "n",
    desc: "Sim speed 1-15",
    host: true,
    run: async ([n], ctx) => {
      const v = Number(n);
      if (!Number.isFinite(v)) throw new Error("SBSPEED needs a number");
      const r = await api.clock(requireSession(ctx), { speed: v });
      say(`Speed ${r.speed}x`);
    },
  },
  {
    name: "SBLOAD",
    aliases: [],
    args: "[name]",
    desc: "Load a server scenario (or the clipboard)",
    host: true,
    run: async ([name], ctx) => {
      const code = requireSession(ctx);
      if (!name) return ctx.loadClipboard();
      const r = await api.loadScript(code, { name });
      say(`Loaded ${name} (${r.commandCount} commands)`);
    },
  },
  {
    name: "DEL",
    aliases: [],
    args: "CS",
    desc: "Delete an aircraft",
    host: true,
    run: async ([cs], ctx) => void (await api.air(requireSession(ctx), findCs(cs).id, { del: true })),
  },
  {
    name: "EMER",
    aliases: [],
    args: "CS",
    desc: "Toggle an emergency",
    host: true,
    run: async ([cs], ctx) => void (await api.air(requireSession(ctx), findCs(cs).id, { emer: true })),
  },
];

const byName = new Map<string, CommandDef>();
for (const c of COMMANDS) for (const n of [c.name, ...c.aliases]) byName.set(n, c);

/** Split "//BAW1", "// BAW1", ".ldarpt irfd twr" into a command and args. */
export function parseLine(line: string): { cmd: string; args: string[] } {
  const t = line.trim().replace(/^\.(?!\/)/, "");
  if (t.startsWith("//")) return { cmd: "//", args: t.slice(2).trim().split(/\s+/).filter(Boolean) };
  const [cmd = "", ...args] = t.split(/\s+/);
  return { cmd: cmd.toUpperCase(), args };
}

export async function runCommand(line: string, ctx: CommandContext): Promise<boolean> {
  const { cmd, args } = parseLine(line);
  if (!cmd) return false;
  const def = byName.get(cmd);
  if (!def) {
    say(`Unknown command ${cmd}`, "error-local");
    return false;
  }
  if (def.host && !ctx.isHost) {
    say(`${def.name} is for hosts only`, "error-local");
    return false;
  }
  try {
    await def.run(args, ctx);
    return true;
  } catch (e) {
    say(e instanceof ApiError || e instanceof Error ? e.message : String(e), "error-local");
    return false;
  }
}

/** Autocomplete: commands (and aliases) starting with the typed text, host-only hidden from viewers. */
export function completions(typed: string, isHost: boolean): { label: string; def: CommandDef }[] {
  const q = typed.replace(/^\./, "").toUpperCase();
  const out: { label: string; def: CommandDef }[] = [];
  for (const def of COMMANDS) {
    if (def.host && !isHost) continue;
    for (const n of [def.name, ...def.aliases]) if (n.startsWith(q)) out.push({ label: n, def });
  }
  return out;
}

/** Runway end names for the scope's runway lists (configured order first). */
export function runwayChoices(apt: string | null, kind: "dep" | "arr"): string[] {
  if (!apt) return [];
  const st = useScope.getState();
  const cfgd = st.rwycfg[apt];
  const all = runwaysOf(apt).flatMap((r) => [r.name1, r.name2]);
  if (cfgd && cfgd !== "disabled") {
    const first = cfgd[kind].map((d) => `${apt}-${d}`).filter((n) => all.includes(n));
    return [...first, ...all.filter((n) => !first.includes(n))];
  }
  return all;
}
