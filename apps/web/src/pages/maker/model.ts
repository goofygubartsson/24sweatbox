// Maker draft: the generator's settings plus editable traffic, saved in this browser.
import { z } from "zod";
import cfg from "@sweatbox/config/public";
import {
  ItemSchema,
  POSITIONS,
  TRAFFIC_LEVELS,
  generatorAirports,
  hasGroundMap,
  parseScript,
  planSweatbox,
  rolloutFor,
  runwayFormats,
  sweatboxScript,
  type GeneratedScript,
  type RunwayFormat,
  type SweatboxItem,
} from "@sweatbox/shared";

export const DraftSchema = z.object({
  v: z.literal(2),
  apt: z.string(),
  position: z.enum(POSITIONS),
  runway: z.string(),
  level: z.enum(TRAFFIC_LEVELS),
  durationMin: z.number().int().min(5).max(240),
  items: z.array(ItemSchema).max(500),
});
export type MakerDraft = z.infer<typeof DraftSchema>;

export function emptyDraft(): MakerDraft {
  const apt = generatorAirports()[0]?.code ?? "IRFD";
  return { v: 2, apt, position: "TWR", runway: runwayFormats(apt)[0]?.id ?? "", level: cfg.generator.defaultLevel, durationMin: cfg.generator.durationMin, items: [] };
}

/** Load from localStorage, schema-sanitised; anything broken or stale falls back to an empty draft. */
export function loadDraft(): MakerDraft {
  try {
    const raw = localStorage.getItem(cfg.ui.makerStorageKey);
    const r = raw ? DraftSchema.safeParse(JSON.parse(raw)) : null;
    if (r?.success && runwayFormats(r.data.apt).some((f) => f.id === r.data.runway)) return r.data;
  } catch {
    // fall through
  }
  return emptyDraft();
}

export function saveDraft(d: MakerDraft): void {
  try {
    localStorage.setItem(cfg.ui.makerStorageKey, JSON.stringify(d));
  } catch {
    // ignore (private mode / quota)
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(cfg.ui.makerStorageKey);
  } catch {
    // ignore
  }
}

export const draftFormat = (d: MakerDraft): RunwayFormat | undefined => runwayFormats(d.apt).find((f) => f.id === d.runway);
export const draftName = (d: MakerDraft): string => `${d.position}-${d.apt}-${d.runway}`;

/** Traffic from the generator for the draft's settings (throws GeneratorError with a reason). */
export function generateItems(d: MakerDraft): SweatboxItem[] {
  return planSweatbox({ apt: d.apt, position: d.position, runway: d.runway, level: d.level, durationMin: d.durationMin }).items;
}

export function draftScript(d: MakerDraft): GeneratedScript | null {
  const format = draftFormat(d);
  if (!format) return null;
  return sweatboxScript({ name: draftName(d), apt: d.apt, position: d.position, format, rollout: rolloutFor(d.position, hasGroundMap(d.apt)), items: d.items });
}

export interface Issue {
  text: string;
  level: "error" | "warning";
  itemId: string | null;
}

/** The server's parser errors and warnings, plus stands used twice at once and duplicate callsigns. */
export function validate(d: MakerDraft, gen: GeneratedScript): Issue[] {
  const r = parseScript(gen.text);
  const lineOf = (msg: string) => Number(/^Line (\d+):/.exec(msg)?.[1] ?? 0);
  const issues: Issue[] = [
    ...r.errors.map((e) => ({ text: e, level: "error" as const, itemId: gen.lineItem.get(lineOf(e)) ?? null })),
    ...r.warnings.map((w) => ({ text: w, level: "warning" as const, itemId: gen.lineItem.get(lineOf(w)) ?? null })),
  ];
  const parked = d.items.filter((i) => (i.kind === "dep-stand" || i.kind === "cct-ga") && i.stand);
  const until = (i: SweatboxItem) => (i.autoDelay === null ? Infinity : i.time + i.autoDelay + cfg.generator.standOccupySec);
  for (let i = 0; i < parked.length; i++)
    for (let j = i + 1; j < parked.length; j++) {
      const a = parked[i]!;
      const b = parked[j]!;
      if (a.stand.toUpperCase() === b.stand.toUpperCase() && a.time < until(b) && b.time < until(a))
        issues.push({ text: `Stand ${d.apt}-${a.stand} is used by ${a.cs} and ${b.cs} at the same time`, level: "warning", itemId: b.id });
    }
  const seen = new Set<string>();
  for (const it of d.items) {
    if (seen.has(it.cs)) issues.push({ text: `Callsign ${it.cs} is used twice`, level: "warning", itemId: it.id });
    seen.add(it.cs);
  }
  return issues;
}
