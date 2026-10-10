import { describe, expect, it } from "vitest";
import { angleDiff, aviationAngle, bearing, displayHeading, fromAviationAngle, nmToUnits, pointAlong, projectOnPolyline, unitsToNm, vec } from "../src/geometry";

describe("aviation angles", () => {
  it("0 = north = -y, 90 = east = +x", () => {
    expect(aviationAngle(vec(0, -1))).toBeCloseTo(0);
    expect(aviationAngle(vec(1, 0))).toBeCloseTo(90);
    expect(aviationAngle(vec(0, 1))).toBeCloseTo(180);
    expect(aviationAngle(vec(-1, 0))).toBeCloseTo(270);
  });

  it("fromAviationAngle(h, L) = (sin h * L, -cos h * L)", () => {
    const v = fromAviationAngle(90, 2);
    expect(v.x).toBeCloseTo(2);
    expect(v.y).toBeCloseTo(0);
    const n = fromAviationAngle(0, 1);
    expect(n.y).toBeCloseTo(-1);
    for (const h of [10, 123, 247, 359]) expect(aviationAngle(fromAviationAngle(h, 3))).toBeCloseTo(h);
  });

  it("angleDiff takes the shorter way", () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(angleDiff(90, 270)).toBe(180);
  });

  it("display headings are 1..360", () => {
    expect(displayHeading(0)).toBe(360);
    expect(displayHeading(359.6)).toBe(360);
    expect(displayHeading(45.2)).toBe(45);
  });

  it("bearing", () => {
    expect(bearing(vec(0, 0), vec(1, -1))).toBeCloseTo(45);
  });
});

describe("units", () => {
  it("1 NM = 3.30714286 map units", () => {
    expect(nmToUnits(1)).toBeCloseTo(3.30714286, 8);
    expect(unitsToNm(3.30714286 * 5)).toBeCloseTo(5);
  });

  it("the sim flies 1 map unit per hour per knot", () => {
    // 3600 ticks of 1 kt along 090 = 1 map unit east
    const step = fromAviationAngle(90, 1 / 3600);
    expect(step.x * 3600).toBeCloseTo(1);
  });
});

describe("polylines", () => {
  const pts = [vec(0, 0), vec(1, 0), vec(1, 1)];
  it("pointAlong walks segments", () => {
    const p = pointAlong(pts, 1.5);
    expect(p.point.x).toBeCloseTo(1);
    expect(p.point.y).toBeCloseTo(0.5);
    expect(p.heading).toBeCloseTo(180);
  });
  it("projectOnPolyline", () => {
    const p = projectOnPolyline(vec(1.2, 0.5), pts);
    expect(p.along).toBeCloseTo(1.5);
    expect(p.lateral).toBeCloseTo(0.2);
  });
});
