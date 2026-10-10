import { describe, expect, it } from "vitest";
import { alongTrackNm, appr, crossTrackUnits, findRunwayEnd, rwyEnd, samePair } from "../src/runways";
import { add, aviationAngle, dist, dot, fromAviationAngle, neg, normalize, scale, sub } from "../src/geometry";
import { airportRef, airports, runwayPairs } from "../src/world";

// Parity tests for the section 5.4 helpers over EVERY runway in the data.
describe.each(runwayPairs.map((p) => [p.name1 + "/" + p.name2.split("-")[1], p] as const))("runway %s", (_label, pair) => {
  const dir = normalize(sub(pair.position2, pair.position1));

  it("appr(name1) = threshold position1, out = -dir", () => {
    const a = appr(findRunwayEnd(pair.name1)!);
    expect(a.threshold).toEqual(pair.position1);
    expect(a.out.x).toBeCloseTo(-dir.x, 12);
    expect(a.out.y).toBeCloseTo(-dir.y, 12);
    expect(a.course).toBeCloseTo(aviationAngle(dir), 9);
  });

  it("appr(name2) = threshold position2, out = dir", () => {
    const a = appr(findRunwayEnd(pair.name2)!);
    expect(a.threshold).toEqual(pair.position2);
    expect(a.out.x).toBeCloseTo(dir.x, 12);
    expect(a.out.y).toBeCloseTo(dir.y, 12);
    expect(a.course).toBeCloseTo(aviationAngle(neg(dir)), 9);
  });

  it("along/cross track on the approach side", () => {
    for (const end of [pair.name1, pair.name2]) {
      const a = appr(findRunwayEnd(end)!);
      const p = add(a.threshold, scale(a.out, 5 * 3.30714286));
      expect(alongTrackNm(a, p)).toBeCloseTo(5, 9);
      expect(crossTrackUnits(a, p)).toBeCloseTo(0, 9);
      // the runway itself is behind the threshold
      const mid = scale(add(pair.position1, pair.position2), 0.5);
      expect(alongTrackNm(a, mid)).toBeLessThan(0);
    }
  });

  it("rwyEnd(name1) = position1 -> position2 along dir; rwyEnd(name2) reversed", () => {
    const e1 = rwyEnd(findRunwayEnd(pair.name1)!);
    const e2 = rwyEnd(findRunwayEnd(pair.name2)!);
    expect(e1.start).toEqual(pair.position1);
    expect(e1.end).toEqual(pair.position2);
    expect(e2.start).toEqual(pair.position2);
    expect(e2.end).toEqual(pair.position1);
    expect(dot(e1.dir, dir)).toBeCloseTo(1, 12);
    expect(dot(e2.dir, dir)).toBeCloseTo(-1, 12);
    expect(e1.heading).toBe(Math.round(aviationAngle(dir)) % 360);
    expect(e1.pair).toBe(`${pair.name1.split("-")[1]}/${pair.name2.split("-")[1]}`);
    expect(e1.length).toBeCloseTo(dist(pair.position1, pair.position2), 12);
  });

  it("runway numbers agree with the runway heading", () => {
    for (const end of [pair.name1, pair.name2]) {
      const g = rwyEnd(findRunwayEnd(end)!);
      const number = Number(/-(\d{2})/.exec(end)![1]);
      const delta = Math.abs(((g.heading - number * 10 + 540) % 360) - 180);
      expect(delta).toBeLessThanOrEqual(10);
    }
  });

  it("takeoff direction leads away from the start", () => {
    const g = rwyEnd(findRunwayEnd(pair.name1)!);
    const p = add(g.start, fromAviationAngle(g.heading, g.length));
    expect(dist(p, g.end)).toBeLessThan(0.02 * g.length + 1e-6);
  });
});

describe("airport reference points", () => {
  it("is the average of all runway endpoints", () => {
    for (const a of airports.filter((x) => x.centre)) {
      const pts = runwayPairs.filter((r) => r.icao === a.code).flatMap((r) => [r.position1, r.position2]);
      const ref = airportRef(a.code)!;
      expect(ref.x).toBeCloseTo(pts.reduce((s, p) => s + p.x, 0) / pts.length, 9);
      expect(ref.y).toBeCloseTo(pts.reduce((s, p) => s + p.y, 0) / pts.length, 9);
    }
  });
});

describe("samePair", () => {
  it("matches in either order", () => {
    expect(samePair("07C/25C", "25C/07C")).toBe(true);
    expect(samePair("07C/25C", "07L/25R")).toBe(false);
  });
});
