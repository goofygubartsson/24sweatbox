// Canvas 2D scope renderer. Map layers are cached in an offscreen canvas; aircraft, tags and
// overlays are drawn every frame. Text is drawn at a fixed screen size regardless of zoom.
import cfg from "@sweatbox/config/public";
import {
  add,
  airportRef,
  airports,
  appr,
  bearing,
  dist,
  findRunwayEnd,
  fixes,
  getAirport,
  getGroundGraph,
  groundArt,
  groundLayout,
  normalize,
  outlines,
  perp,
  runwayPairs,
  runwaysOf,
  scale,
  squawkFor,
  sub,
  unitsToNm,
  type GroundMapData,
  type Strips,
  type Vec,
} from "@sweatbox/shared";
import type { Camera } from "./camera";
import { trafficColour, type RAircraft, type ViewMode } from "./model";

const C = cfg.colours;
const SC = C.scope;
const GC = C.ground;
const GS = cfg.ui.ground;
const U = cfg.sim.unitsPerNm;
const MONO = `ui-monospace, "Cascadia Mono", "Segoe UI Mono", "Liberation Mono", Menlo, Monaco, Consolas, monospace`;
const TAG_FONT = `${cfg.ui.tagFontWeight} ${cfg.ui.tagFontPx}px ${MONO}`;
const LABEL_FONT = `${cfg.ui.labelFontPx}px "DIN Mittelschrift", "Arial Narrow", sans-serif`;
const MARK_FONT = `${cfg.ui.markFontPx}px "DIN Mittelschrift", "Arial Narrow", sans-serif`;
const GROUND_LABEL_FONT = `${GS.labelPx}px ${MONO}`;
const RUNWAY_NUMBER_FONT = `${GS.runwayNumberPx}px ${MONO}`;
const LINE_H = cfg.ui.tagFontPx + 1;

export interface TagNote {
  cfl?: string;
  asp?: string;
  ahdg?: string;
}

export interface Ruler {
  a: Vec;
  b: Vec;
}

export type TagField = "cs" | "cfl" | "asp" | "ahdg" | "dest" | "type" | "rmk";

export interface Hit {
  kind: "tag" | "symbol";
  id: string;
  cs: string;
  field?: TagField;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MakerOverlay {
  points: { x: number; y: number; label: string; colour: string; selected?: boolean }[];
  lines: { pts: [number, number][]; colour: string; dashed?: boolean }[];
  stands: { x: number; y: number; label: string; warn?: boolean }[];
}

export interface Scene {
  aircraft: RAircraft[];
  apt: string | null;
  mode: ViewMode;
  fixesAlways: boolean;
  selectedId: string | null;
  notes: Record<string, TagNote>;
  assumed: ReadonlySet<string>;
  strips: Strips;
  /** Callsigns whose route is shown. */
  routes: ReadonlySet<string>;
  routeFor: (a: RAircraft) => { name: string; pos: Vec }[];
  /** Runway ends with extended centrelines. */
  centrelines: string[];
  taxiPath: [number, number][] | null;
  pickNodes: boolean;
  pickedNodes: number[];
  hoverNode: number | null;
  maker?: MakerOverlay;
  tags: boolean;
  /** Highlight a callsign (route hover in the strips). */
  flash?: string | null;
}

export interface Overlay {
  tagOffsets: Map<string, [number, number]>;
  rulers: Ruler[];
  liveRuler: Ruler | null;
  mouse: { x: number; y: number } | null;
}

// ---- cached Path2D for static outlines -----------------------------------------------------------------

let coastPath: Path2D | null = null;
let airspacePath: Path2D | null = null;
const artCache = new Map<string, { pavement: Path2D; taxilines: Path2D; buildings: { p: Path2D; fill: string }[]; holds: Path2D }>();

/**
 * One Path2D from many SVG "d" strings. Each string is added on its own: concatenating them would
 * turn every later relative "m" into an offset from the previous path.
 */
function multiPath(ds: string[]): Path2D {
  const p = new Path2D();
  for (const d of ds) p.addPath(new Path2D(d));
  return p;
}
function coast(): Path2D {
  coastPath ??= multiPath(outlines.coast);
  return coastPath;
}
function airspace(): Path2D {
  airspacePath ??= multiPath(outlines.airspace);
  return airspacePath;
}
function art(icao: string) {
  const a = groundArt[icao];
  if (!a) return null;
  let c = artCache.get(icao);
  if (!c) {
    c = {
      pavement: multiPath(a.pavement),
      taxilines: multiPath(a.taxilines),
      buildings: a.buildings.map((b) => ({ p: new Path2D(b.d), fill: b.fill })),
      holds: polygons(a.holds ?? [], false),
    };
    artCache.set(icao, c);
  }
  return c;
}

interface GroundPaths {
  land: Path2D;
  pavement: Path2D;
  buildings: Path2D;
  taxilines: Path2D;
  standlines: Path2D;
  holds: Path2D;
}
const groundPathCache = new WeakMap<GroundMapData, GroundPaths>();

function polygons(polys: [number, number][][], close = true): Path2D {
  const p = new Path2D();
  for (const poly of polys) {
    poly.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    if (close) p.closePath();
  }
  return p;
}
function polylines(lines: Vec[][]): Path2D {
  const p = new Path2D();
  for (const line of lines) line.forEach((v, i) => (i ? p.lineTo(v.x, v.y) : p.moveTo(v.x, v.y)));
  return p;
}
/** A ground map draws itself only when it has its own pavement; otherwise the ground-art is used. */
const ownDrawing = (icao: string) => {
  const m = groundLayout(icao);
  return m?.pavement.length ? m : undefined;
};

/** Paths for an airport's ground layout; the centre and stand lines come from its taxi graph, if any. */
function groundPaths(icao: string): GroundPaths | null {
  const m = ownDrawing(icao);
  if (!m) return null;
  let c = groundPathCache.get(m);
  if (!c) {
    const g = getGroundGraph(icao);
    c = {
      land: polygons(m.land),
      pavement: polygons(m.pavement),
      buildings: polygons(m.buildings),
      taxilines: polylines(g?.taxilines ?? []),
      standlines: polylines(g?.standlines ?? []),
      holds: polygons(m.holds, false),
    };
    groundPathCache.set(m, c);
  }
  return c;
}

/** Airports drawn with the loaded one in GND/TWR (itself + its satellites). */
function fieldAirports(apt: string | null): string[] {
  if (!apt) return [];
  return [apt, ...(getAirport(apt)?.topDowns ?? [])];
}

// ---- map layer --------------------------------------------------------------------------------------------

let mapCanvas: HTMLCanvasElement | null = null;
let mapKey = "";

function worldTransform(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number) {
  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * (cam.w / 2 - cam.cx * cam.zoom), dpr * (cam.h / 2 - cam.cy * cam.zoom));
}

const rwyHalfWidth = (icao: string): number => groundLayout(icao)?.rwyHalfWidth ?? groundArt[icao.toUpperCase()]?.rwyHalfWidth ?? GS.defaultRwyHalfWidth;

/** Runway rectangles, with each end's number just beyond its threshold (GND and TWR views). */
function drawRunwayRects(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, icao: string) {
  const hw = rwyHalfWidth(icao);
  ctx.save();
  worldTransform(ctx, cam, dpr);
  ctx.fillStyle = GC.runway;
  ctx.strokeStyle = GC.runwayOutline;
  ctx.lineWidth = GS.runwayOutlinePx / cam.zoom;
  for (const r of runwaysOf(icao)) {
    const side = scale(perp(normalize(sub(r.position2, r.position1))), hw);
    const corners = [add(r.position1, side), add(r.position2, side), sub(r.position2, side), sub(r.position1, side)];
    ctx.beginPath();
    corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = RUNWAY_NUMBER_FONT;
  ctx.fillStyle = GC.runwayNumber;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const r of runwaysOf(icao)) {
    const [x1, y1] = cam.toScreen(r.position1.x, r.position1.y);
    const [x2, y2] = cam.toScreen(r.position2.x, r.position2.y);
    const l = Math.hypot(x2 - x1, y2 - y1) || 1;
    const gap = GS.runwayNumberPx; // one character height beyond the threshold
    const ux = ((x2 - x1) / l) * gap;
    const uy = ((y2 - y1) / l) * gap;
    ctx.fillText(r.name1.split("-")[1]!, x1 - ux, y1 - uy);
    ctx.fillText(r.name2.split("-")[1]!, x2 + ux, y2 + uy);
  }
  ctx.restore();
}

/**
 * An airport's ground layout, bottom to top: land, pavement, buildings, runways, taxiway centrelines,
 * stand lead-in lines (GND only) and the runway holding-position bars, always on top and at full
 * strength. TWR dims pavement, buildings and centrelines; CTR shows it the same way under its own
 * runway lines when zoomed onto a field. Airports without a ground map use the older artwork.
 */
function drawGround(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, apt: string, mode: ViewMode) {
  const paths = groundPaths(apt);
  const old = paths ? null : art(apt);
  const dim = mode !== "GND";
  const px = 1 / cam.zoom; // one CSS pixel in world units
  ctx.save();
  worldTransform(ctx, cam, dpr);
  if (paths) {
    ctx.fillStyle = GC.land;
    ctx.fill(paths.land, "evenodd");
    ctx.lineWidth = GS.landOutlinePx * px;
    ctx.strokeStyle = GC.landOutline;
    ctx.stroke(paths.land);
    ctx.globalAlpha = dim ? GS.twrPavementAlpha : 1;
    ctx.fillStyle = GC.pavement;
    ctx.fill(paths.pavement, "evenodd");
    ctx.fillStyle = GC.building;
    ctx.fill(paths.buildings, "evenodd");
    ctx.lineWidth = GS.buildingOutlinePx * px;
    ctx.strokeStyle = GC.buildingOutline;
    ctx.stroke(paths.buildings);
  } else if (old) {
    ctx.globalAlpha = dim ? GS.twrPavementAlpha : 1;
    ctx.fillStyle = GC.pavement;
    ctx.fill(old.pavement);
    for (const b of old.buildings) {
      ctx.fillStyle = b.fill.toLowerCase() === "#ffffff" ? GC.runway : GC.building;
      ctx.fill(b.p);
    }
  }
  ctx.restore();
  if (mode !== "CTR") drawRunwayRects(ctx, cam, dpr, apt);
  ctx.save();
  worldTransform(ctx, cam, dpr);
  ctx.globalAlpha = dim ? GS.twrTaxilineAlpha : 1;
  ctx.lineWidth = GS.taxilinePx * px;
  ctx.strokeStyle = GC.taxiline;
  if (paths) ctx.stroke(paths.taxilines);
  else if (old) ctx.stroke(old.taxilines);
  ctx.globalAlpha = 1;
  if (paths && mode === "GND") {
    ctx.lineWidth = GS.standlinePx * px;
    ctx.strokeStyle = GC.standline;
    ctx.stroke(paths.standlines);
  }
  const holds = paths?.holds ?? old?.holds;
  if (holds) {
    ctx.lineWidth = GS.holdPx * px;
    ctx.strokeStyle = GC.hold;
    ctx.stroke(holds);
  }
  ctx.restore();
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Taxiway, stand, runway and area labels: GND view only, zoomed in, never under a tag. */
function drawGroundLabels(ctx: CanvasRenderingContext2D, cam: Camera, scene: Scene, tags: Rect[]) {
  if (scene.mode !== "GND" || cam.zoom < GS.labelMinZoom) return;
  ctx.save();
  ctx.font = GROUND_LABEL_FONT;
  ctx.fillStyle = GC.label;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const h = GS.labelPx;
  for (const apt of fieldAirports(scene.apt)) {
    for (const l of ownDrawing(apt)?.labels ?? groundArt[apt]?.labels ?? []) {
      const [sx, sy] = cam.toScreen(l.p[0], l.p[1]);
      if (sx < -h * 4 || sy < -h || sx > cam.w + h * 4 || sy > cam.h + h) continue;
      const w = ctx.measureText(l.t).width;
      const box = { x: sx - w / 2, y: sy - h / 2, w, h };
      if (tags.some((t) => overlaps(box, t))) continue;
      ctx.fillText(l.t, sx, sy);
    }
  }
  ctx.restore();
}

/** CTR view runways: lines, with numbers once zoomed in enough to read them. */
function drawRunways(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, skip: ReadonlySet<string> | null) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "butt";
  for (const r of runwayPairs) {
    if (skip?.has(r.icao)) continue;
    const [x1, y1] = cam.toScreen(r.position1.x, r.position1.y);
    const [x2, y2] = cam.toScreen(r.position2.x, r.position2.y);
    const halfWidth = rwyHalfWidth(r.icao);
    ctx.strokeStyle = SC.runway;
    ctx.lineWidth = Math.max(2, halfWidth * 2 * cam.zoom);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // numbers just outside each threshold, when zoomed in enough to read them
    if (cam.zoom >= 14) {
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      ctx.font = LABEL_FONT;
      ctx.fillStyle = SC.runwayLabel;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(r.name1.split("-")[1]!, x1 - ux * 12, y1 - uy * 12);
      ctx.fillText(r.name2.split("-")[1]!, x2 + ux * 12, y2 + uy * 12);
    }
  }
  ctx.restore();
}

function drawCentrelines(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, ends: string[]) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = SC.centreline;
  ctx.lineWidth = 1;
  for (const name of ends) {
    const end = findRunwayEnd(name);
    if (!end) continue;
    const a = appr(end);
    const far = { x: a.threshold.x + a.out.x * 10 * U, y: a.threshold.y + a.out.y * 10 * U };
    const [x1, y1] = cam.toScreen(a.threshold.x, a.threshold.y);
    const [x2, y2] = cam.toScreen(far.x, far.y);
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 1 NM ticks
    for (let nm = 1; nm <= 10; nm++) {
      const p = { x: a.threshold.x + a.out.x * nm * U, y: a.threshold.y + a.out.y * nm * U };
      const [sx, sy] = cam.toScreen(p.x, p.y);
      const t = nm % 5 === 0 ? 6 : 3;
      ctx.beginPath();
      ctx.moveTo(sx - a.out.y * t, sy + a.out.x * t);
      ctx.lineTo(sx + a.out.y * t, sy - a.out.x * t);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawFixes(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "middle";
  for (const f of fixes) {
    if (f.layer === "aeronav") continue; // aeronav fixes are valid for routes but not drawn
    const [sx, sy] = cam.toScreen(f.pos.x, f.pos.y);
    if (sx < -40 || sy < -20 || sx > cam.w + 40 || sy > cam.h + 20) continue;
    const navaid = f.type !== "FIX";
    ctx.strokeStyle = navaid ? SC.navaid : SC.fix;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (f.type === "NDB") ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    else if (navaid) ctx.rect(sx - 3.5, sy - 3.5, 7, 7);
    else {
      ctx.moveTo(sx, sy - 4);
      ctx.lineTo(sx + 3.5, sy + 2.5);
      ctx.lineTo(sx - 3.5, sy + 2.5);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.fillStyle = SC.fixLabel;
    ctx.fillText(f.name, sx + 6, sy);
  }
  ctx.restore();
}

function drawAirportLabels(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  ctx.fillStyle = SC.airport;
  for (const a of airports) {
    if (!a.centre) continue;
    const [sx, sy] = cam.toScreen(a.centre[0], a.centre[1]);
    ctx.fillText(a.code, sx, sy + 14);
  }
  ctx.restore();
}

function renderMap(cam: Camera, scene: Scene, dpr: number): HTMLCanvasElement {
  const key = [cam.key(), dpr, scene.mode, scene.apt, scene.fixesAlways, scene.centrelines.join(",")].join("|");
  if (mapCanvas && key === mapKey) return mapCanvas;
  mapCanvas ??= document.createElement("canvas");
  mapCanvas.width = Math.round(cam.w * dpr);
  mapCanvas.height = Math.round(cam.h * dpr);
  const ctx = mapCanvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
  const field = new Set(fieldAirports(scene.apt));

  // island outlines in every view, so GND and TWR keep their geographic surroundings
  ctx.save();
  worldTransform(ctx, cam, dpr);
  ctx.fillStyle = SC.land;
  ctx.fill(coast(), "evenodd");
  ctx.lineWidth = cfg.ui.mapLineWidthPx / cam.zoom;
  ctx.strokeStyle = SC.coastline;
  ctx.stroke(coast());
  if (scene.mode === "CTR") {
    ctx.strokeStyle = SC.airspace;
    ctx.stroke(airspace());
  }
  ctx.restore();

  if (scene.mode === "CTR") {
    drawCentrelines(ctx, cam, dpr, scene.centrelines);
    // ground layout under the runway lines when zoomed onto a field
    if (cam.zoom > 80) for (const a of airports) if (a.centre && (groundLayout(a.code) || groundArt[a.code])) drawGround(ctx, cam, dpr, a.code, "CTR");
    drawRunways(ctx, cam, dpr, null);
    if (scene.fixesAlways || cam.zoom >= cfg.ui.fixesMinZoom) drawFixes(ctx, cam, dpr);
    if (cam.zoom < 60) drawAirportLabels(ctx, cam, dpr);
  } else {
    for (const apt of field) drawGround(ctx, cam, dpr, apt, scene.mode);
    if (scene.mode === "TWR") {
      drawRunways(ctx, cam, dpr, field); // neighbouring airports stay visible
      drawCentrelines(ctx, cam, dpr, scene.centrelines);
    }
    if (scene.fixesAlways) drawFixes(ctx, cam, dpr);
  }
  mapKey = key;
  return mapCanvas;
}

/** Force the cached map layer to be redrawn (e.g. after fonts load). */
export function invalidateMap(): void {
  mapKey = "";
}

// ---- aircraft & tags ------------------------------------------------------------------------------------

interface Seg {
  text: string;
  field?: TagField;
  colour?: string;
}

function visible(a: RAircraft, scene: Scene): { show: boolean; tag: boolean } {
  if (scene.mode === "CTR" || !scene.apt) return { show: true, tag: true };
  const ref = airportRef(scene.apt);
  const nm = ref ? unitsToNm(dist(a, ref)) : Infinity;
  if (scene.mode === "GND") {
    if (a.onGround) return { show: nm < 5, tag: true };
    return { show: a.altitude < cfg.ui.gndAirborneMaxFt && nm < cfg.ui.gndAirborneMaxNm, tag: true };
  }
  // TWR
  if (a.onGround) {
    const g = a.dto?.gnd;
    const atRunway =
      g !== null &&
      g !== undefined &&
      (["lineup", "lined", "takeoff", "rollout"].includes(g.mode) ||
        (g.mode === "holding" && g.status.startsWith("HOLDING SHORT")) ||
        (g.mode === "taxi" && g.status.includes("HOLD SHORT") && (g.path?.length ?? 99) < 4));
    return { show: nm < 5, tag: atRunway };
  }
  const near = a.altitude < cfg.ui.twrArrivalMaxFt && nm < cfg.ui.twrArrivalMaxNm;
  return { show: true, tag: near && (a.arr === scene.apt || a.dep === scene.apt) };
}

const pad3 = (n: number) => String(Math.max(0, Math.round(n))).padStart(3, "0");

/**
 * Tag text, laid out like the original sweatbox scope.
 *   unassumed:  BHL78 0             callsign, ground speed
 *               000 S92             altitude (hundreds), type
 *   assumed:    BHL78 M V 1054 0    callsign, wake, flight rules, squawk, ground speed
 *               000 000 IMLR 000 S92 000
 *                                   altitude (with climb / descent arrow), CFL, destination, ASP, type, AHDG
 *               207 RMK             heading, remark
 * CFL / ASP / AHDG / RMK are the controller's own notes: type a value and click the field to set
 * it, right-click to clear it.
 */
function tagLines(a: RAircraft, scene: Scene): Seg[][] {
  const note = scene.notes[a.callsign] ?? {};
  const strip = scene.strips[a.callsign] ?? {};
  const cs: Seg = { text: a.callsign, field: "cs", colour: a.emergency ? C.emergency : undefined };
  const gs = String(Math.round(a.gs));
  const trend = a.vs > cfg.ui.tagTrendFpm ? "↑" : a.vs < -cfg.ui.tagTrendFpm ? "↓" : "";
  const alt = `${pad3(a.altitude / 100)}${trend}`;
  if (!scene.assumed.has(a.callsign)) return [[cs, { text: ` ${gs}` }], [{ text: `${alt} ` }, { text: a.type, field: "type" }]];
  const rules = (a.fp?.flightRules ?? "IFR").startsWith("V") ? "V" : "I";
  // CFL: the controller's note, else the strip's CLMB (they are kept in step)
  const clmb = Number(strip.o_clmb ?? strip.clmb);
  const cfl = note.cfl ?? (clmb > 0 ? pad3(clmb / 100) : "000");
  const sp: Seg = { text: " " };
  return [
    [cs, { text: ` ${a.wake} ${rules} ` }, { text: squawkFor(a.callsign), colour: C.tag.squawk }, { text: ` ${gs}` }],
    [
      { text: alt },
      sp,
      { text: cfl, field: "cfl" },
      sp,
      { text: a.arr ?? "----", field: "dest" },
      sp,
      { text: note.asp ?? "000", field: "asp" },
      sp,
      { text: a.type, field: "type" },
      sp,
      { text: note.ahdg ?? "000", field: "ahdg" },
    ],
    [{ text: `${pad3(a.heading) === "000" ? "360" : pad3(a.heading)} ` }, { text: strip.rmk || "RMK", field: "rmk" }],
  ];
}

function drawRoute(ctx: CanvasRenderingContext2D, cam: Camera, a: RAircraft, pts: { name: string; pos: Vec }[]) {
  if (!pts.length) return;
  ctx.strokeStyle = SC.route;
  ctx.fillStyle = SC.route;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  const [sx, sy] = cam.toScreen(a.x, a.y);
  ctx.moveTo(sx, sy);
  for (const p of pts) {
    const [x, y] = cam.toScreen(p.pos.x, p.pos.y);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "middle";
  for (const p of pts) {
    const [x, y] = cam.toScreen(p.pos.x, p.pos.y);
    ctx.fillRect(x - 2, y - 2, 4, 4);
    ctx.fillText(p.name, x + 6, y - 8);
  }
}

function drawRuler(ctx: CanvasRenderingContext2D, cam: Camera, r: Ruler, live: boolean) {
  const [x1, y1] = cam.toScreen(r.a.x, r.a.y);
  const [x2, y2] = cam.toScreen(r.b.x, r.b.y);
  ctx.strokeStyle = SC.ruler;
  ctx.fillStyle = SC.ruler;
  ctx.lineWidth = 1;
  ctx.setLineDash(live ? [4, 3] : []);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  const hdg = Math.round(bearing(r.a, r.b)) || 360;
  const nm = unitsToNm(dist(r.a, r.b));
  ctx.font = MARK_FONT;
  ctx.textBaseline = "bottom";
  ctx.fillText(`${String(hdg).padStart(3, "0")}° ${nm.toFixed(1)} NM`, x2 + 8, y2 - 4);
}

interface Placed {
  a: RAircraft;
  sx: number;
  sy: number;
  colour: string;
  selected: boolean;
  flash: boolean;
  /** Tag text and box (screen CSS px), when the tag is shown. */
  tag: (Rect & { lines: Seg[][] }) | null;
}

/**
 * Where every shown aircraft and its tag go this frame (selected last, so drawn on top). A tag sits
 * above right of its symbol, or where the user dragged it; tags may overlap.
 */
function placeAircraft(ctx: CanvasRenderingContext2D, cam: Camera, scene: Scene, ov: Overlay): Placed[] {
  ctx.font = TAG_FONT;
  const out: Placed[] = [];
  const [dx, dy] = cfg.ui.tagOffsetPx as [number, number];
  for (const a of scene.aircraft) {
    const vis = visible(a, scene);
    if (!vis.show) continue;
    const [sx, sy] = cam.toScreen(a.x, a.y);
    if (sx < -200 || sy < -120 || sx > cam.w + 200 || sy > cam.h + 120) continue;
    const base = trafficColour(a, scene.apt);
    const selected = a.id === scene.selectedId;
    const colour = selected ? (base === C.departure ? C.selectedOnDeparture : C.selected) : base;
    let tag: Placed["tag"] = null;
    if (scene.tags && vis.tag) {
      const lines = tagLines(a, scene);
      let w = 0;
      for (const l of lines) w = Math.max(w, l.reduce((s, seg) => s + ctx.measureText(seg.text).width, 0));
      const h = lines.length * LINE_H;
      // the default offset is the tag's bottom-left corner; a dragged tag keeps its top-left corner
      const off = ov.tagOffsets.get(a.id) ?? [dx, dy - h];
      tag = { lines, x: sx + off[0], y: sy + off[1], w, h };
    }
    out.push({ a, sx, sy, colour, selected, flash: scene.flash === a.callsign, tag });
  }
  return out.sort((x, y) => Number(x.selected) - Number(y.selected));
}

/** Draw a frame. Returns hit regions (screen CSS px) for tags and symbols. */
export function drawScene(ctx: CanvasRenderingContext2D, cam: Camera, scene: Scene, ov: Overlay, dpr: number): Hit[] {
  const hits: Hit[] = [];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = SC.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(renderMap(cam, scene, dpr), 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const placed = placeAircraft(ctx, cam, scene, ov);
  drawGroundLabels(
    ctx,
    cam,
    scene,
    placed.flatMap((p) => (p.tag ? [{ x: p.tag.x - 3, y: p.tag.y - 2, w: p.tag.w + 6, h: p.tag.h + 3 }] : [])),
  );

  // selected aircraft's planned taxi route (dashed)
  if (scene.taxiPath && scene.taxiPath.length > 1) {
    ctx.strokeStyle = GC.taxiRoute;
    ctx.lineWidth = GS.taxiRoutePx;
    ctx.setLineDash([...GS.taxiRouteDash]);
    ctx.beginPath();
    scene.taxiPath.forEach(([x, y], i) => {
      const [sx, sy] = cam.toScreen(x, y);
      if (i) ctx.lineTo(sx, sy);
      else ctx.moveTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // map-pick mode: highlight graph nodes
  if (scene.pickNodes && scene.apt) {
    const g = getGroundGraph(scene.apt);
    if (g) {
      g.nodes.forEach((n, i) => {
        const [sx, sy] = cam.toScreen(n.x, n.y);
        if (sx < -10 || sy < -10 || sx > cam.w + 10 || sy > cam.h + 10) return;
        const picked = scene.pickedNodes.includes(i);
        ctx.fillStyle = picked ? C.theme.primary : i === scene.hoverNode ? SC.route : SC.pickNode;
        ctx.beginPath();
        ctx.arc(sx, sy, picked || i === scene.hoverNode ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  // maker overlay
  if (scene.maker) {
    for (const l of scene.maker.lines) {
      ctx.strokeStyle = l.colour;
      ctx.lineWidth = 1;
      ctx.setLineDash(l.dashed ? [5, 4] : []);
      ctx.beginPath();
      l.pts.forEach(([x, y], i) => {
        const [sx, sy] = cam.toScreen(x, y);
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = MARK_FONT;
    ctx.textBaseline = "middle";
    for (const s of scene.maker.stands) {
      const [sx, sy] = cam.toScreen(s.x, s.y);
      ctx.strokeStyle = s.warn ? C.theme.danger : GC.label;
      ctx.strokeRect(sx - 3, sy - 3, 6, 6);
      ctx.fillStyle = s.warn ? C.theme.danger : GC.label;
      ctx.fillText(s.label, sx + 6, sy);
    }
    for (const p of scene.maker.points) {
      const [sx, sy] = cam.toScreen(p.x, p.y);
      ctx.fillStyle = p.colour;
      ctx.strokeStyle = p.colour;
      ctx.lineWidth = p.selected ? 2 : 1;
      ctx.beginPath();
      ctx.arc(sx, sy, p.selected ? 6 : 4, 0, Math.PI * 2);
      p.selected ? ctx.stroke() : ctx.fill();
      ctx.fillText(p.label, sx + 8, sy);
    }
  }

  // routes
  for (const a of scene.aircraft) if (scene.routes.has(a.callsign)) drawRoute(ctx, cam, a, scene.routeFor(a));

  // aircraft
  ctx.font = TAG_FONT;
  ctx.textBaseline = "top";
  for (const { a, sx, sy, colour, selected, flash, tag } of placed) {
    // history trail
    ctx.fillStyle = SC.trail;
    a.trail.forEach(([tx, ty], i) => {
      const [hx, hy] = cam.toScreen(tx, ty);
      ctx.globalAlpha = 1 - i / (a.trail.length + 1);
      ctx.fillRect(hx - 1, hy - 1, 2, 2);
    });
    ctx.globalAlpha = 1;

    // speed vector (distance flown in vectorMinutes)
    if (!a.onGround && cfg.ui.vectorMinutes > 0) {
      const len = (a.gs / 60) * cfg.ui.vectorMinutes;
      const rad = (a.heading * Math.PI) / 180;
      const [vx, vy] = cam.toScreen(a.x + Math.sin(rad) * len, a.y - Math.cos(rad) * len);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(vx, vy);
      ctx.stroke();
    }

    // symbol
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = selected || flash ? 2 : 1.2;
    if (a.onGround) {
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      scene.assumed.has(a.callsign) ? ctx.fill() : ctx.stroke();
    } else {
      scene.assumed.has(a.callsign) ? ctx.fillRect(sx - 3.5, sy - 3.5, 7, 7) : ctx.strokeRect(sx - 3.5, sy - 3.5, 7, 7);
    }
    if (a.emergency) {
      ctx.strokeStyle = C.emergency;
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    hits.push({ kind: "symbol", id: a.id, cs: a.callsign, x: sx - 7, y: sy - 7, w: 14, h: 14 });

    if (!tag) continue;
    const { lines, x: tx, y: ty, w: width, h: height } = tag;
    // tag text: grey until assumed, then white; the selected aircraft's tag in its highlight colour
    const text = selected || flash ? colour : scene.assumed.has(a.callsign) ? C.tag.assumed : C.tag.unassumed;
    // leader line to the nearest tag edge
    const lx = Math.max(tx, Math.min(sx, tx + width));
    const ly = Math.max(ty, Math.min(sy, ty + height));
    if (Math.hypot(lx - sx, ly - sy) > 8) {
      ctx.strokeStyle = C.tag.leader;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(lx, ly);
      ctx.stroke();
    }
    if (selected || flash) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.strokeRect(tx - 3, ty - 2, width + 6, height + 3);
    }
    hits.push({ kind: "tag", id: a.id, cs: a.callsign, x: tx - 3, y: ty - 2, w: width + 6, h: height + 3 });
    lines.forEach((segs, li) => {
      let x = tx;
      const y = ty + li * LINE_H;
      for (const s of segs) {
        const w = ctx.measureText(s.text).width;
        ctx.fillStyle = s.colour ?? text;
        ctx.fillText(s.text, x, y);
        if (s.field) hits.push({ kind: "tag", id: a.id, cs: a.callsign, field: s.field, x, y, w, h: LINE_H });
        x += w;
      }
    });
  }

  // rulers
  for (const r of ov.rulers) drawRuler(ctx, cam, r, false);
  if (ov.liveRuler) drawRuler(ctx, cam, ov.liveRuler, true);
  return hits;
}

/** Topmost hit at a screen point (fields before whole tags before symbols). */
export function hitTest(hits: Hit[], x: number, y: number): Hit | null {
  const inside = (h: Hit) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h;
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i]!.field && inside(hits[i]!)) return hits[i]!;
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i]!.kind === "tag" && inside(hits[i]!)) return hits[i]!;
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i]!.kind === "symbol" && inside(hits[i]!)) return hits[i]!;
  return null;
}
