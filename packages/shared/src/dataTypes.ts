import { z } from "zod";

// Schemas of the generated JSON in packages/shared/src/data (written by scripts/build-data.ts from /data).
// Points are [x, y] in map units.

export const Pt = z.tuple([z.number(), z.number()]);
export type Pt = z.infer<typeof Pt>;
const Poly = z.array(Pt);

export const AirportSchema = z.object({
  code: z.string().regex(/^I[A-Z0-9]{3}$/),
  name: z.string(),
  iata: z.string(),
  /** Station frequencies keyed by position (CTR, APP, TWR, GND, DEL). */
  freqs: z.record(z.string()),
  /** Satellite airports drawn together with this one. */
  topDowns: z.array(z.string()),
  /** Airport reference point (average of runway ends), null when the airport has no runways. */
  centre: Pt.nullable(),
  /** Runway pairs as "07C/25C". */
  runways: z.array(z.string()),
  /** Main departure runway per direction ("25L"); without one, generated sweatboxes pick one. */
  depRunways: z.array(z.string()).default([]),
});
export type Airport = z.infer<typeof AirportSchema>;

export const RunwayPairSchema = z.object({
  icao: z.string(),
  name1: z.string(), // "IRFD-07R"
  name2: z.string(), // "IRFD-25L"
  position1: Pt, // threshold of name1
  position2: Pt, // threshold of name2
});
export type RunwayPairData = z.infer<typeof RunwayPairSchema>;

export const FixSchema = z.object({
  name: z.string().regex(/^[A-Z0-9]{2,7}$/),
  type: z.string(),
  pos: Pt,
  /** main: always drawn; aeronav: drawn only in the AERONAV style; extra: estimated (SID) fixes. */
  layer: z.enum(["main", "aeronav", "extra"]),
});
export type FixData = z.infer<typeof FixSchema>;

/** { APT: { TOKEN: { RWY | "ALL": [fixes] } } }, TOKEN = "SID" or "SID.TRANSITION". */
export const SidsSchema = z.record(z.record(z.record(z.array(z.string()))));
export type SidTable = z.infer<typeof SidsSchema>;

export const WakeSchema = z.enum(["L", "M", "H", "J"]);
export type Wake = z.infer<typeof WakeSchema>;

export const AircraftDataSchema = z.object({
  /** Roblox type name (lower-cased, " cargo" stripped) -> ICAO designator. */
  types: z.record(z.string()),
  /** ICAO designator -> wake category and length in metres. */
  info: z.record(z.object({ wake: WakeSchema, lengthM: z.number().positive() })),
});
export type AircraftData = z.infer<typeof AircraftDataSchema>;

export const CallsignDataSchema = z.object({
  /** PTFS spoof airline / spoken name (lower-cased) -> ICAO airline code. */
  spoof: z.record(z.string()),
  /** ICAO airline code -> radio callsign. */
  radio: z.record(z.string()),
});
export type CallsignData = z.infer<typeof CallsignDataSchema>;

export const OutlinesSchema = z.object({
  coast: z.array(z.string()), // SVG path "d" strings in map units
  airspace: z.array(z.string()),
});
export type Outlines = z.infer<typeof OutlinesSchema>;

export const SectorsSchema = z.record(z.object({ name: z.string(), polygon: Poly }));
export type Sectors = z.infer<typeof SectorsSchema>;

export const GroundEdgeSchema = z.object({
  a: z.number().int().nonnegative(),
  b: z.number().int().nonnegative(),
  name: z.string(), // taxiway name ("APRON" = unnamed apron taxilane, "" on stand lead-ins)
  pts: Poly,
  stand: z.string().optional(), // set on stand lead-in edges (a = the stand node, b = its junction)
  crossing: z.string().optional(), // runway pair this segment lies on ("07R/25L"): on it = on the runway
});

/** Taxiway designators, stand numbers, runway and area names ("Fuel"), drawn on the GND view. */
export const GroundLabelSchema = z.object({ t: z.string(), k: z.enum(["twy", "stand", "rwy", "area"]), p: Pt });

export const GroundMapSchema = z.object({
  icao: z.string(),
  source: z.string(),
  rwyHalfWidth: z.number().positive(),
  // drawing layers; a map without pavement keeps the airport's ground-art drawing
  land: z.array(Poly).default([]),
  pavement: z.array(Poly).default([]),
  buildings: z.array(Poly).default([]),
  holds: z.array(Poly).default([]), // hold-bar polylines (drawing)
  labels: z.array(GroundLabelSchema).default([]),
  // the taxi graph; a map without one (while it is being built) is drawn but has no ground traffic
  ground: z
    .object({
      nodes: z.array(Pt),
      edges: z.array(GroundEdgeSchema),
      holds: z.array(z.object({ n: z.number().int(), twy: z.string(), rwy: z.string(), name: z.string() })),
      entries: z.array(z.object({ n: z.number().int(), rwy: z.string(), twy: z.string() })),
      stands: z.array(z.object({ name: z.string(), n: z.number().int(), j: z.number().int(), hdg: z.number(), line: Poly })),
    })
    .optional(),
});
export type GroundMapData = z.infer<typeof GroundMapSchema>;
/** A ground map with its taxi graph: DEL / GND traffic needs one. */
export type RoutableGroundMap = GroundMapData & { ground: NonNullable<GroundMapData["ground"]> };
export const isRoutable = (m: GroundMapData | undefined): m is RoutableGroundMap => Boolean(m?.ground);

/** Ground artwork (drawing only, no routing graph): SVG path strings in map units. */
export const GroundArtSchema = z.object({
  source: z.string(),
  pavement: z.array(z.string()),
  taxilines: z.array(z.string()),
  buildings: z.array(z.object({ d: z.string(), fill: z.string() })),
  // optional overlays, as on a ground map: runway half-width, hold-bar polylines, labels
  rwyHalfWidth: z.number().positive().optional(),
  holds: z.array(Poly).optional(),
  labels: z.array(GroundLabelSchema).optional(),
});
export type GroundArt = z.infer<typeof GroundArtSchema>;

export const ManifestSchema = z.object({
  builtAt: z.string(),
  counts: z.record(z.number()),
  warnings: z.array(z.string()),
});
export type Manifest = z.infer<typeof ManifestSchema>;
