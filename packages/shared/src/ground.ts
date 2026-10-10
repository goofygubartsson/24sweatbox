// Ground map routing graph (spec section 6.1) and taxi path finding (section 6.3).
// Shared: the server moves aircraft along these paths, the scope draws them and picks nodes.
import cfg from "@sweatbox/config/public";
import { isRoutable, type RoutableGroundMap } from "./dataTypes";
import { aviationAngle, dist, neg, normalize, polylineLength, sub, toVec, type Vec } from "./geometry";
import { pairHasDesignator, samePair } from "./runways";
import { groundMapsData } from "./world";

export interface GEdge {
  id: number;
  a: number;
  b: number;
  /** Taxiway name, upper case. */
  name: string;
  /** Polyline from node a to node b (endpoints included). */
  pts: Vec[];
  len: number;
  stand?: string;
  /** Runway pair this segment lies on (a runway crossing). */
  crossing?: string;
  runway: boolean;
}

export interface GStand {
  name: string;
  n: number;
  j: number;
  hdg: number;
  line: Vec[];
}

export interface GHold {
  n: number;
  twy: string;
  rwy: string;
  name: string;
}

export interface GEntry {
  n: number;
  rwy: string;
  twy: string;
}

export interface GroundGraph {
  icao: string;
  data: RoutableGroundMap;
  nodes: Vec[];
  edges: GEdge[];
  /** node -> incident edge ids */
  adj: number[][];
  holds: GHold[];
  entries: GEntry[];
  stands: GStand[];
  standByName: Map<string, GStand>;
  /** Upper-case names of all non-stand edges. */
  taxiways: Set<string>;
  /** Derived drawing layers: centrelines of every non-stand edge, and every stand line. */
  taxilines: Vec[][];
  standlines: Vec[][];
}

export interface GPath {
  nodes: number[];
  edges: number[];
  length: number;
}

/** Runway edges are named like "07C/25C", "25L" or "RWY ...". AUTO routing avoids them. */
export function isRunwayName(name: string): boolean {
  return /\//.test(name) || /^\d{2}[LCR]?$/.test(name) || /^RWY/i.test(name);
}

export function buildGroundGraph(data: RoutableGroundMap, icao = data.icao): GroundGraph {
  const nodes = data.ground.nodes.map(toVec);
  const edges: GEdge[] = data.ground.edges.map((e, id) => {
    let pts = e.pts.map(toVec);
    const A = nodes[e.a]!;
    const B = nodes[e.b]!;
    // make sure the polyline runs a -> b and includes both endpoints
    if (pts.length >= 2 && dist(pts[0]!, B) + dist(pts[pts.length - 1]!, A) < dist(pts[0]!, A) + dist(pts[pts.length - 1]!, B))
      pts = [...pts].reverse();
    if (!pts.length || dist(pts[0]!, A) > 1e-6) pts = [A, ...pts];
    if (dist(pts[pts.length - 1]!, B) > 1e-6) pts = [...pts, B];
    const name = e.name.toUpperCase();
    return { id, a: e.a, b: e.b, name, pts, len: polylineLength(pts), stand: e.stand, crossing: e.crossing, runway: !e.stand && !e.crossing && isRunwayName(name) };
  });
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a]!.push(e.id);
    if (e.b !== e.a) adj[e.b]!.push(e.id);
  }
  const stands: GStand[] = data.ground.stands.map((s) => ({ ...s, name: s.name.toUpperCase(), line: s.line.map(toVec) }));
  return {
    icao: icao.toUpperCase(),
    data,
    nodes,
    edges,
    adj,
    holds: data.ground.holds.map((h) => ({ ...h, twy: h.twy.toUpperCase(), name: h.name.toUpperCase() })),
    entries: data.ground.entries.map((e) => ({ ...e, twy: e.twy.toUpperCase() })),
    stands,
    standByName: new Map(stands.map((s) => [s.name, s])),
    taxiways: new Set(edges.filter((e) => !e.stand).map((e) => e.name)),
    taxilines: edges.filter((e) => !e.stand).map((e) => e.pts),
    standlines: stands.map((s) => s.line),
  };
}

const cache = new Map<string, GroundGraph | null>();

/** The ground graph of an airport, or undefined when it has no ground map. */
export function getGroundGraph(icao: string): GroundGraph | undefined {
  const key = icao.toUpperCase();
  if (!cache.has(key)) {
    const data = groundMapsData[key];
    cache.set(key, isRoutable(data) ? buildGroundGraph(data, key) : null);
  }
  return cache.get(key) ?? undefined;
}

/** Register a graph built elsewhere (tests use a synthetic airport). */
export function registerGroundGraph(g: GroundGraph): void {
  cache.set(g.icao, g);
}

export const otherEnd = (e: GEdge, n: number): number => (e.a === n ? e.b : e.a);

/** Edge polyline oriented to start at node `from`. */
export function edgePointsFrom(e: GEdge, from: number): Vec[] {
  return e.a === from ? e.pts : [...e.pts].reverse();
}

/** Initial direction (unit vector) leaving node `from` along edge e. */
export function edgeDirFrom(e: GEdge, from: number): Vec {
  const p = edgePointsFrom(e, from);
  return normalize(sub(p[1] ?? p[0]!, p[0]!));
}

/** Polyline of a path (starting at its first node). */
export function pathPoints(g: GroundGraph, path: GPath): Vec[] {
  const out: Vec[] = [g.nodes[path.nodes[0]!]!];
  path.edges.forEach((eid, i) => {
    const pts = edgePointsFrom(g.edges[eid]!, path.nodes[i]!);
    out.push(...pts.slice(1));
  });
  return out;
}

/** Taxiway names at a node (non-stand edges), sorted. */
export function nodeTaxiways(g: GroundGraph, n: number): string[] {
  return [...new Set(g.adj[n]!.map((id) => g.edges[id]!).filter((e) => !e.stand).map((e) => e.name))].sort();
}

export function nearestNode(g: GroundGraph, p: Vec, maxDist = Infinity): number | null {
  let best: number | null = null;
  let bestD = maxDist;
  g.nodes.forEach((n, i) => {
    const d = dist(n, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// ---- Dijkstra ----------------------------------------------------------------------------------------

class MinHeap<T> {
  private items: { k: number; v: T }[] = [];
  get size() {
    return this.items.length;
  }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.k <= a[i]!.k) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): { k: number; v: T } | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Generic Dijkstra over (node, state) pairs. `step` returns the next state when edge e may be taken
 * from (node, state), or null. `goal` decides when we are done.
 */
function search<S extends string | number>(
  g: GroundGraph,
  start: number,
  startState: S,
  step: (e: GEdge, from: number, state: S, prevEdge: number | null) => S | null,
  goal: (n: number, state: S) => boolean,
): GPath | null {
  const key = (n: number, s: S) => `${n}|${s}`;
  const best = new Map<string, number>();
  const prev = new Map<string, { from: string; edge: number; node: number; state: S } | null>();
  const heap = new MinHeap<{ n: number; s: S; edge: number | null }>();
  best.set(key(start, startState), 0);
  prev.set(key(start, startState), null);
  heap.push(0, { n: start, s: startState, edge: null });
  while (heap.size) {
    const { k: d, v } = heap.pop()!;
    const kk = key(v.n, v.s);
    if (d > (best.get(kk) ?? Infinity)) continue;
    if (goal(v.n, v.s)) {
      const nodes: number[] = [];
      const edges: number[] = [];
      let cur: string | undefined = kk;
      let node = v.n;
      while (cur !== undefined) {
        nodes.push(node);
        const p = prev.get(cur);
        if (!p) break;
        edges.push(p.edge);
        node = p.node;
        cur = p.from;
      }
      return { nodes: nodes.reverse(), edges: edges.reverse(), length: d };
    }
    for (const eid of g.adj[v.n]!) {
      if (eid === v.edge) continue; // no immediate U-turn on the same edge
      const e = g.edges[eid]!;
      const ns = step(e, v.n, v.s, v.edge);
      if (ns === null) continue;
      const m = otherEnd(e, v.n);
      const nk = key(m, ns);
      const nd = d + e.len;
      if (nd < (best.get(nk) ?? Infinity)) {
        best.set(nk, nd);
        prev.set(nk, { from: kk, edge: eid, node: v.n, state: v.s });
        heap.push(nd, { n: m, s: ns, edge: eid });
      }
    }
  }
  return null;
}

export interface PathOptions {
  /** Do not use runway edges (default true). */
  avoidRunways?: boolean;
  /** Stand edges may only be used for this stand (null = none). */
  stand?: string | null;
  /** Edge the aircraft is sitting on and may not leave through first (no U-turn after pushback). */
  forbidFirstEdge?: number | null;
  /** Edges to keep off (blocked by traffic). */
  avoidEdges?: ReadonlySet<number>;
}

function edgeAllowed(e: GEdge, opts: PathOptions, standOfStart: string | null): boolean {
  if (opts.avoidEdges?.has(e.id)) return false;
  if (e.stand && e.stand.toUpperCase() !== (opts.stand ?? "").toUpperCase() && e.stand.toUpperCase() !== standOfStart) return false;
  if (e.runway && opts.avoidRunways !== false) return false;
  return true;
}

/** Shortest path between two nodes (optionally through intermediate nodes, in order). */
export function shortestPath(g: GroundGraph, from: number, to: number, opts: PathOptions = {}, via: number[] = []): GPath | null {
  const standOfStart = g.stands.find((s) => s.n === from)?.name ?? null;
  const targets = [...via, to];
  return search<number>(
    g,
    from,
    via.length && via[0] === from ? 1 : 0,
    (e, n, k, prevEdge) => {
      if (prevEdge === null && opts.forbidFirstEdge === e.id) return null;
      if (!edgeAllowed(e, opts, standOfStart)) return null;
      const m = otherEnd(e, n);
      return k < targets.length - 1 && m === targets[k] ? k + 1 : k;
    },
    (n, k) => k === targets.length - 1 && n === to,
  );
}

export type ViaResult = { ok: true; path: GPath } | { ok: false; why: string };

/**
 * Path that follows a taxi clearance: the named taxiways in order (spec 6.3), through optional
 * picked nodes, to a goal (a node, or "the end of the last taxiway" when goal is null). It reads
 * the clearance the way a pilot does, in three phases:
 *  - join: from where the aircraft is onto the first named taxiway, the shortest way (stand
 *    lead-in, apron, a connector), without using the other named taxiways out of order;
 *  - follow: the named taxiways in order, changing at a node they share;
 *  - finish: onto the goal's own taxiway when the clearance stops one short of it (the hold on A5
 *    reached "via A").
 */
export function routeVia(
  g: GroundGraph,
  from: number,
  route: string[],
  goal: number | number[] | null,
  opts: PathOptions & { picked?: number[] } = {},
): ViaResult {
  const twys = route.map((t) => t.toUpperCase());
  if (!twys.length) return { ok: false, why: "Pick taxiways" };
  for (const t of twys) if (!g.taxiways.has(t)) return { ok: false, why: `Unknown taxiway ${t}` };
  const nodesOf = (t: string) => new Set(g.edges.filter((e) => e.name === t).flatMap((e) => [e.a, e.b]));
  for (let i = 1; i < twys.length; i++) {
    const a = nodesOf(twys[i - 1]!);
    if (![...nodesOf(twys[i]!)].some((n) => a.has(n)))
      return { ok: false, why: `${twys[i - 1]} doesn't join ${twys[i]}, add the taxiway between them` };
  }
  const picked = opts.picked ?? [];
  const last = twys.length - 1;
  const goals = goal === null ? null : new Set(Array.isArray(goal) ? goal : [goal]);
  // finish phase: only when no goal lies on the last named taxiway
  const goalTwys = new Set(goals ? [...goals].flatMap((n) => nodeTaxiways(g, n)) : []);
  const finish = goals !== null && !goalTwys.has(twys[last]!);
  const named = new Set(twys);
  // "end of the last taxiway": a node of the last taxiway with no other edge of that taxiway
  const deadEnds = new Set(
    [...nodesOf(twys[last]!)].filter((n) => g.adj[n]!.filter((id) => g.edges[id]!.name === twys[last]).length === 1),
  );
  const standOfStart = g.stands.find((s) => s.n === from)?.name ?? null;
  // state = phase * 100 + picked count; phase 0 = joining, 1..n = on twys[phase - 1], n + 1 = finishing
  const JOIN = 0;
  const FINISH = twys.length + 1;
  const enc = (phase: number, k: number) => phase * 100 + k;
  const path = search<number>(
    g,
    from,
    enc(JOIN, picked[0] === from ? 1 : 0),
    (e, n, s, prevEdge) => {
      if (prevEdge === null && opts.forbidFirstEdge === e.id) return null;
      if (!edgeAllowed(e, opts, standOfStart)) return null;
      let phase = Math.floor(s / 100);
      let k = s % 100;
      if (e.stand) {
        // stand lead-ins: only the aircraft's own stand (start) or the target stand (end)
      } else if (phase === JOIN) {
        if (e.name === twys[0]) phase = 1;
        else if (named.has(e.name)) return null;
      } else if (phase < FINISH) {
        const i = phase - 1;
        if (e.name === twys[i]) {
          // stay on the current taxiway
        } else if (i < last && e.name === twys[i + 1]) phase += 1;
        else if (i === last && finish && goalTwys.has(e.name)) phase = FINISH;
        else return null;
      } else if (!goalTwys.has(e.name)) return null;
      const m = otherEnd(e, n);
      if (k < picked.length && m === picked[k]) k += 1;
      return enc(phase, k);
    },
    (n, s) => {
      const phase = Math.floor(s / 100);
      if (s % 100 !== picked.length) return false;
      if (phase !== twys.length && phase !== FINISH) return false;
      if (goals) return goals.has(n);
      return deadEnds.has(n) && n !== from;
    },
  );
  if (!path) {
    if (picked.length) return { ok: false, why: `Can't follow ${twys.join(" ")} through the picked points` };
    // tell apart "can't get onto the first taxiway" from "can't get to the goal along them"
    const join = search<number>(
      g,
      from,
      0,
      (e, _n, s, prevEdge) => (prevEdge === null && opts.forbidFirstEdge === e.id) || !edgeAllowed(e, opts, standOfStart) ? null : s,
      (n) => nodesOf(twys[0]!).has(n),
    );
    if (!join) return { ok: false, why: `Can't reach ${twys[0]} from here` };
    return { ok: false, why: `No route along ${twys.join(" ")}` };
  }
  return { ok: true, path };
}

/**
 * Where a path must stop before crossing a runway: for every crossing edge on the path, the
 * runway's holding point just before it (or the entry node when there is no hold bar).
 */
export function crossingStops(g: GroundGraph, path: GPath): { node: number; rwy: string }[] {
  const stops: { node: number; rwy: string }[] = [];
  path.edges.forEach((eid, k) => {
    const rwy = g.edges[eid]!.crossing;
    if (!rwy) return;
    // the entry we are about to leave was reached via the hold, so look back along the path
    let node = path.nodes[k]!;
    for (let i = k; i >= Math.max(0, k - 3); i--) {
      const n = path.nodes[i]!;
      if (g.holds.some((h) => h.n === n && samePair(h.rwy, rwy))) {
        node = n;
        break;
      }
    }
    // the first node of the path is where the aircraft already is: it has been cleared from there
    if (node !== path.nodes[0] && !stops.some((s) => s.node === node)) stops.push({ node, rwy });
  });
  return stops;
}

/** Hold-short goal for "T:<twy>": nodes on taxiway `along` that touch taxiway `twy`. */
export function holdShortNodes(g: GroundGraph, along: string | null, twy: string): number[] {
  const t = twy.toUpperCase();
  const onT = new Set(g.edges.filter((e) => e.name === t).flatMap((e) => [e.a, e.b]));
  if (!along) return [...onT];
  const onAlong = new Set(g.edges.filter((e) => e.name === along.toUpperCase()).flatMap((e) => [e.a, e.b]));
  return [...onT].filter((n) => onAlong.has(n));
}

/** Runway holds for a runway designator or pair ("25L" or "07R/25L"). */
export function holdsForRunway(g: GroundGraph, rwy: string): GHold[] {
  return g.holds.filter((h) => (rwy.includes("/") ? samePair(h.rwy, rwy) : pairHasDesignator(h.rwy, rwy)));
}

/** Runway entry nodes for a runway pair string. */
export function entriesForRunway(g: GroundGraph, pair: string): GEntry[] {
  return g.entries.filter((e) => samePair(e.rwy, pair));
}

/** A hold is valid for AUTO / takeoff only when an entry for the same runway is close to it. */
export function entryNearHold(g: GroundGraph, h: GHold, maxDist = cfg.ground.autoHoldEntryMaxUnits): GEntry | null {
  let best: GEntry | null = null;
  let bestD = maxDist;
  for (const e of entriesForRunway(g, h.rwy)) {
    const d = dist(g.nodes[e.n]!, g.nodes[h.n]!);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export interface PushOption {
  hdg: number;
  twy: string;
  /** Edge the tail ends up on (no U-turn onto it afterwards); -1 at a dead end, where the tail goes into the end. */
  edge: number;
}

/** Pushback facing options from a stand: one per taxiway edge at the stand's junction. */
export function pushFacingOptions(g: GroundGraph, stand: GStand): PushOption[] {
  const out: PushOption[] = [];
  const taxiways = g.adj[stand.j]!.map((id) => g.edges[id]!).filter((e) => !e.stand);
  for (const e of taxiways) {
    const d = edgeDirFrom(e, stand.j);
    // the tail goes along this edge, so the nose ends up facing the other way; at the end of a
    // taxiway the tail goes into the end and the nose faces out along it
    const deadEnd = taxiways.length === 1;
    out.push({ hdg: Math.round(aviationAngle(deadEnd ? d : neg(d))) % 360 || 360, twy: e.name, edge: deadEnd ? -1 : e.id });
  }
  return out;
}

/** Stand lead-in polyline from the junction to the stand node. */
export function standLeadIn(g: GroundGraph, stand: GStand): Vec[] {
  const edge = g.adj[stand.n]!.map((id) => g.edges[id]!).find((e) => e.stand && otherEnd(e, stand.n) === stand.j);
  if (edge) return edgePointsFrom(edge, stand.j);
  const J = g.nodes[stand.j]!;
  const N = g.nodes[stand.n]!;
  if (stand.line.length >= 2) {
    const line = dist(stand.line[0]!, J) <= dist(stand.line[stand.line.length - 1]!, J) ? stand.line : [...stand.line].reverse();
    return [J, ...line.filter((p) => dist(p, J) > 1e-6 && dist(p, N) > 1e-6), N];
  }
  return [J, N];
}
