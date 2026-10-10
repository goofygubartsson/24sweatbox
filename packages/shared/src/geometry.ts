// 2D geometry in PTFS map units. x grows east, y grows SOUTH (screen-like).
// Aviation angle: 0 = north = -y, 90 = east = +x. A vector for heading h and length L is
// (sin h * L, -cos h * L).
import cfg from "@sweatbox/config/public";

export interface Vec {
  x: number;
  y: number;
}

export const DEG = Math.PI / 180;

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y });
/** Perpendicular, rotated +90 degrees in maths terms: (-y, x). */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function normalize(a: Vec): Vec {
  const l = len(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Heading in degrees [0, 360) of a vector; 0 = north (-y). */
export function aviationAngle(v: Vec): number {
  const a = Math.atan2(v.x, -v.y) / DEG;
  return ((a % 360) + 360) % 360;
}

/** Vector of length L pointing along heading h (degrees). */
export function fromAviationAngle(h: number, L = 1): Vec {
  return { x: Math.sin(h * DEG) * L, y: -Math.cos(h * DEG) * L };
}

/** Bearing from a to b in degrees [0, 360). */
export const bearing = (a: Vec, b: Vec): number => aviationAngle(sub(b, a));

/** Normalise any angle into [0, 360). */
export function norm360(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Heading for display: 1..360 (north is 360, never 0). */
export function displayHeading(h: number): number {
  const r = Math.round(norm360(h));
  return r === 0 ? 360 : r;
}

/** Signed shortest turn from a to b in degrees, in (-180, 180]. Positive = right turn. */
export function angleDiff(a: number, b: number): number {
  let d = norm360(b - a);
  if (d > 180) d -= 360;
  return d;
}

export const nmToUnits = (nm: number): number => nm * cfg.sim.unitsPerNm;
export const unitsToNm = (u: number): number => u / cfg.sim.unitsPerNm;

/** Closest point on segment ab to p, with t in [0, 1]. */
export function closestOnSegment(p: Vec, a: Vec, b: Vec): { point: Vec; t: number; dist: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const point = add(a, scale(ab, t));
  return { point, t, dist: dist(p, point) };
}

/** Total length of a polyline. */
export function polylineLength(pts: Vec[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1]!, pts[i]!);
  return s;
}

/** Point at distance d along a polyline (clamped), with the heading of that segment. */
export function pointAlong(pts: Vec[], d: number): { point: Vec; heading: number; index: number } {
  if (pts.length === 0) return { point: vec(0, 0), heading: 0, index: 0 };
  let remaining = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = dist(a, b);
    if (remaining <= seg || i === pts.length - 1) {
      const t = seg === 0 ? 1 : Math.min(1, remaining / seg);
      return { point: lerp(a, b, t), heading: seg === 0 ? 0 : bearing(a, b), index: i };
    }
    remaining -= seg;
  }
  return { point: pts[0]!, heading: 0, index: 0 };
}

/** Closest point on a polyline to p: distance along it, lateral distance and the point. */
export function projectOnPolyline(p: Vec, pts: Vec[]): { along: number; lateral: number; point: Vec; index: number } {
  let best = { along: 0, lateral: Infinity, point: pts[0] ?? vec(0, 0), index: 1 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = closestOnSegment(p, a, b);
    if (c.dist < best.lateral) best = { along: acc + c.t * dist(a, b), lateral: c.dist, point: c.point, index: i };
    acc += dist(a, b);
  }
  return best;
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const toVec = (p: readonly [number, number] | number[]): Vec => ({ x: p[0]!, y: p[1]! });
export const fromVec = (v: Vec): [number, number] => [v.x, v.y];
export const round = (n: number, dp: number): number => {
  const k = 10 ** dp;
  return Math.round(n * k) / k;
};
