// Route strings: "HDG250", "FIX1,FIX2", "KENED2.JOOPY JOOPY DCT POPPY", "VIS", "CCT".
// Shared so the server (departures) and the scope (route display) expand them the same way.
import cfg from "@sweatbox/config/public";
import { add, cross, dist, dot, fromAviationAngle, lerp, scale, sub, type Vec } from "./geometry";
import { findRunwayEnd, rwyEnd } from "./runways";
import { airportRef, fixes, getFix, sids } from "./world";

export interface RoutePoint {
  name: string;
  pos: Vec;
}

export const HDG_ROUTE_RE = /^HDG(\d{1,3})$/;

export function routeTokens(route: string): string[] {
  return route
    .toUpperCase()
    .split(/[\s,]+/)
    .filter((t) => t !== "" && t !== "DCT");
}

/** Heading of an "HDGxxx" route (1-360), or null. */
export function routeHeading(route: string): number | null {
  const t = routeTokens(route);
  const m = t.length === 1 ? HDG_ROUTE_RE.exec(t[0]!) : null;
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 1 && h <= 360 ? h : null;
}

/** True for a SID token published at this airport ("KENED2" or "KENED2.JOOPY"). */
export function isSidToken(apt: string, token: string): boolean {
  const table = sids[apt.toUpperCase()];
  if (!table) return false;
  const base = token.split(".")[0]!;
  return Object.keys(table).some((k) => k === token || k.split(".")[0] === base);
}

export interface SidChoice {
  token: string;
  fixes: string[];
}

/**
 * Pick the SID fixes for a departure runway designator ("25L"). Exact token first (runway, then
 * ALL); otherwise the best published one: same SID name preferred, transition closest to the
 * destination.
 */
export function chooseSid(apt: string, token: string, rwy: string | null, arr?: string | null): SidChoice | null {
  const table = sids[apt.toUpperCase()];
  if (!table) return null;
  const forRwy = (entry: Record<string, string[]>) => (rwy && entry[rwy]) ?? entry["ALL"];
  const exact = table[token];
  if (exact) {
    const list = forRwy(exact);
    if (list) return { token, fixes: list };
  }
  const dest = arr ? airportRef(arr) : null;
  const base = token.split(".")[0]!;
  const candidates = Object.entries(table)
    .map(([t, entry]) => ({ token: t, fixes: forRwy(entry) }))
    .filter((c): c is SidChoice => Array.isArray(c.fixes));
  if (!candidates.length) return null;
  const sameName = candidates.filter((c) => c.token.split(".")[0] === base);
  const pool = sameName.length ? sameName : candidates;
  const score = (c: SidChoice) => {
    const last = c.fixes.length ? getFix(c.fixes[c.fixes.length - 1]!) : getFix(c.token.split(".")[1] ?? "");
    return dest && last ? dist(last.pos, dest) : 0;
  };
  return [...pool].sort((a, b) => score(a) - score(b))[0]!;
}

/**
 * A route of published fixes from one airport toward another ("STRAX,ROM,GAVIN"): about one fix
 * every generator.routeFixEveryNm, each the one closest to the direct line in its stretch, none in
 * the last fifth of the way (the arrival joins a final from there). Null when the airports are
 * unknown; the fix nearest the halfway point when nothing lies close to the line.
 */
export function fixRouteBetween(dep: string, arr: string): string | null {
  const a = airportRef(dep);
  const b = airportRef(arr);
  if (!a || !b || dep.toUpperCase() === arr.toUpperCase()) return null;
  const length = dist(a, b);
  const dir = scale(sub(b, a), 1 / length);
  const U = cfg.sim.unitsPerNm;
  const corridor = Math.max(cfg.generator.routeCorridorNm * U, length * 0.2);
  const [from, to] = [0.12, 0.8];
  const main = fixes.filter((f) => f.layer === "main");
  const near = main
    .map((f) => ({ name: f.name, t: dot(sub(f.pos, a), dir) / length, off: Math.abs(cross(dir, sub(f.pos, a))) }))
    .filter((c) => c.t > from && c.t < to && c.off <= corridor);
  const n = Math.max(1, Math.min(4, Math.round(length / U / cfg.generator.routeFixEveryNm)));
  const picked: string[] = [];
  for (let i = 0; i < n; i++) {
    const lo = from + ((to - from) * i) / n;
    const hi = from + ((to - from) * (i + 1)) / n;
    const best = near.filter((c) => c.t >= lo && c.t < hi).sort((p, q) => p.off - q.off)[0];
    if (best) picked.push(best.name);
  }
  if (picked.length) return picked.join(",");
  const mid = lerp(a, b, 0.5);
  const nearest = [...main].sort((p, q) => dist(p.pos, mid) - dist(q.pos, mid))[0];
  return nearest?.name ?? null;
}

/** En-route waypoints from `from` toward the destination in 1.5-5 NM steps. */
export function enrouteWaypoints(from: Vec, dest: Vec): RoutePoint[] {
  const total = dist(from, dest) / cfg.sim.unitsPerNm;
  const stepNm = Math.min(cfg.sim.routeWpMaxNm, Math.max(cfg.sim.routeWpMinNm, total / 8));
  const n = Math.floor((total - cfg.sim.arrivalRemoveNm) / stepNm);
  const out: RoutePoint[] = [];
  for (let i = 1; i <= n; i++)
    out.push({ name: `WP${String(i).padStart(2, "0")}`, pos: lerp(from, dest, (i * stepNm) / total) });
  return out;
}

export interface ExpandedRoute {
  heading: number | null;
  points: RoutePoint[];
  unknown: string[];
  sid: string | null;
}

/**
 * Expand a route for an aircraft. `runway` is the departure runway end ("IRFD-25L") when known;
 * SID tokens are resolved for it. After a SID, en-route waypoints lead toward `arr`.
 */
export function expandRoute(route: string, opts: { dep?: string | null; arr?: string | null; runway?: string | null }): ExpandedRoute {
  const heading = routeHeading(route);
  const res: ExpandedRoute = { heading, points: [], unknown: [], sid: null };
  if (heading !== null) return res;
  const dep = opts.dep?.toUpperCase() ?? null;
  const end = opts.runway ? findRunwayEnd(opts.runway) : undefined;
  const designator = end?.designator ?? null;
  for (const token of routeTokens(route)) {
    if (token === "VIS" || token === "CCT" || HDG_ROUTE_RE.test(token)) continue;
    if (dep && !res.sid && isSidToken(dep, token)) {
      const choice = chooseSid(dep, token, designator, opts.arr);
      if (!choice) continue;
      res.sid = choice.token;
      if (choice.fixes.length) {
        for (const f of choice.fixes) {
          const fix = getFix(f);
          if (fix) res.points.push({ name: fix.name, pos: fix.pos });
          else res.unknown.push(f);
        }
      } else if (end) {
        // empty SID: straight out, then the transition fix if any
        const g = rwyEnd(end);
        res.points.push({ name: "DEP", pos: add(g.end, fromAviationAngle(g.heading, cfg.sim.depStraightOutNm * cfg.sim.unitsPerNm)) });
        const transition = getFix(choice.token.split(".")[1] ?? "");
        if (transition) res.points.push({ name: transition.name, pos: transition.pos });
      }
      continue;
    }
    const fix = getFix(token);
    if (!fix) res.unknown.push(token);
    else if (res.points[res.points.length - 1]?.name !== fix.name) res.points.push({ name: fix.name, pos: fix.pos });
  }
  // after a SID: generated en-route waypoints toward the destination ("SID TERMINUS WP...")
  const dest = opts.arr ? airportRef(opts.arr) : null;
  const last = res.points[res.points.length - 1];
  if (res.sid && dest && last && opts.arr?.toUpperCase() !== dep) res.points.push(...enrouteWaypoints(last.pos, dest));
  return res;
}
