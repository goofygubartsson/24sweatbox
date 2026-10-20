// Scope page state. One scope per page, so a module-level store is fine.
import { create } from "zustand";
import cfg from "@sweatbox/config/public";
import type { LogLevel, SessionStats, Snapshot, Strips } from "@sweatbox/shared";
import { loadJson, saveJson } from "../lib/storage";
import type { SocketStatus } from "../lib/ws";
import { fromSession, type RAircraft, type ViewMode } from "./model";
import type { TagNote } from "./draw";

export interface Message {
  id: number;
  text: string;
  level: LogLevel | "local" | "error-local";
  atSec?: number;
  fresh?: boolean;
}

export type WidgetKind = "qf";
export interface Widget {
  id: string;
  kind: WidgetKind;
  arg?: string;
}

export type RwyCfg = Record<string, { dep: string[]; arr: string[] } | "disabled">;

export interface PickState {
  kind: "taxi" | "push" | "follow";
  nodes: number[];
}

interface ScopeState {
  code: string | null;
  snap: Snapshot | null;
  aircraft: RAircraft[];
  strips: Strips;
  ended: SessionStats | null;
  socket: SocketStatus;
  messages: Message[];
  apt: string | null;
  mode: ViewMode;
  ctrCamera: { cx: number; cy: number; zoom: number } | null;
  fixesAlways: boolean;
  /** Minimum safe altitude areas shown (.MSA). */
  msa: boolean;
  selectedId: string | null;
  notes: Record<string, TagNote>;
  assumed: Set<string>;
  routes: Set<string>;
  rwycfg: RwyCfg;
  widgets: Widget[];
  pick: PickState | null;
  hostPanel: boolean;
  makerOpen: boolean;
  /** Command line text (bottom left); a value typed here can be dropped onto a tag field. */
  cmdText: string;
  version: number;
  /** Highest scriptTag seq applied per aircraft id (script ALT/SPD/HDG -> tag notes). */
  tagSeq: Record<string, number>;

  bump: () => void;
  reset: (code: string | null) => void;
  applySnapshot: (s: Snapshot) => void;
  setAircraft: (list: RAircraft[]) => void;
  say: (text: string, level?: Message["level"]) => void;
  select: (id: string | null) => void;
  setNote: (cs: string, field: keyof TagNote, value: string | null) => void;
  toggleAssumed: (cs: string) => boolean;
  toggleRoute: (cs: string) => void;
  setView: (apt: string | null, mode: ViewMode) => void;
  set: (patch: Partial<ScopeState>) => void;
}

let msgId = 1;
const notesKey = (code: string | null) => `notes.${code ?? "live"}`;
const assumedKey = (code: string | null) => `assumed.${code ?? "live"}`;

export const useScope = create<ScopeState>((set, get) => ({
  code: null,
  snap: null,
  aircraft: [],
  strips: {},
  ended: null,
  socket: "closed",
  messages: [],
  apt: null,
  mode: "CTR",
  ctrCamera: null,
  fixesAlways: false,
  msa: false,
  selectedId: null,
  notes: {},
  assumed: new Set(),
  routes: new Set(),
  rwycfg: loadJson<RwyCfg>("rwycfg", {}),
  widgets: [],
  pick: null,
  hostPanel: false,
  makerOpen: false,
  cmdText: "",
  version: 0,
  tagSeq: {},

  bump: () => set((s) => ({ version: s.version + 1 })),

  reset: (code) =>
    set({
      code,
      snap: null,
      aircraft: [],
      strips: {},
      ended: null,
      messages: [],
      selectedId: null,
      routes: new Set(),
      pick: null,
      tagSeq: {},
      notes: loadJson<Record<string, TagNote>>(notesKey(code), {}, (raw) => (raw && typeof raw === "object" ? (raw as Record<string, TagNote>) : null)),
      assumed: new Set(loadJson<string[]>(assumedKey(code), [], (raw) => (Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : null))),
    }),

  applySnapshot: (s) => {
    const st = get();
    const incoming: Message[] = s.log.map((l) => ({ id: msgId++, text: l.message, level: l.level, atSec: l.atSec, fresh: true }));
    const messages = incoming.length ? [...st.messages.map((m) => ({ ...m, fresh: false })), ...incoming].slice(-cfg.session.logLimit) : st.messages;
    // script ALT / SPD / HDG update everyone's tag notes
    const notes = { ...st.notes };
    const tagSeq = { ...st.tagSeq };
    let notesChanged = false;
    for (const a of s.aircraft) {
      const t = a.scriptTag;
      if (!t || (tagSeq[a.id] ?? 0) >= t.seq) continue;
      tagSeq[a.id] = t.seq;
      const n = { ...(notes[a.callsign] ?? {}) };
      if (t.alt !== undefined) n.cfl = String(Math.round(t.alt / 100)).padStart(3, "0");
      if (t.speed !== undefined) n.asp = String(t.speed);
      if (t.heading !== undefined) n.ahdg = String(t.heading).padStart(3, "0");
      notes[a.callsign] = n;
      notesChanged = true;
    }
    if (notesChanged) saveJson(notesKey(st.code), notes);
    const selectedGone = st.selectedId && !s.aircraft.some((a) => a.id === st.selectedId);
    set({
      snap: s,
      strips: s.strips,
      aircraft: fromSession(s.aircraft, s.flightPlans, s.strips),
      messages,
      notes,
      tagSeq,
      selectedId: selectedGone ? null : st.selectedId,
      ended: s.ended && s.stats ? s.stats : st.ended,
      version: st.version + 1,
    });
  },

  setAircraft: (list) => set((s) => ({ aircraft: list, version: s.version + 1 })),

  say: (text, level = "local") =>
    set((s) => ({ messages: [...s.messages.map((m) => ({ ...m, fresh: false })), { id: msgId++, text, level, fresh: true }].slice(-cfg.session.logLimit) })),

  select: (id) => set((s) => ({ selectedId: id, version: s.version + 1 })),

  setNote: (cs, field, value) => {
    const st = get();
    const n = { ...(st.notes[cs] ?? {}) };
    if (value === null || value === "") delete n[field];
    else n[field] = value.toUpperCase();
    const notes = { ...st.notes, [cs]: n };
    saveJson(notesKey(st.code), notes);
    set({ notes, version: st.version + 1 });
  },

  toggleAssumed: (cs) => {
    const st = get();
    const assumed = new Set(st.assumed);
    const now = !assumed.has(cs);
    if (now) assumed.add(cs);
    else assumed.delete(cs);
    saveJson(assumedKey(st.code), [...assumed]);
    set({ assumed, version: st.version + 1 });
    return now;
  },

  toggleRoute: (cs) =>
    set((s) => {
      const routes = new Set(s.routes);
      if (routes.has(cs)) routes.delete(cs);
      else routes.add(cs);
      return { routes, version: s.version + 1 };
    }),

  setView: (apt, mode) => set((s) => ({ apt, mode, version: s.version + 1, pick: null })),

  set: (patch) => set((s) => ({ ...patch, version: s.version + 1 })),
}));

export function saveRwyCfg(r: RwyCfg): void {
  saveJson("rwycfg", r);
}
