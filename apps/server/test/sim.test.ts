import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  add,
  alongTrackNm,
  appr,
  aviationAngle,
  buildGroundGraph,
  dist,
  entryNearHold,
  findRunwayEnd,
  fromAviationAngle,
  generateSweatbox,
  lengthUnits,
  getGroundGraph,
  projectOnPolyline,
  registerAirport,
  registerGroundGraph,
  registerGroundMapData,
  registerRunwayPair,
  rwyEnd,
  samePair,
  scale,
  shortestPath,
  type RoutableGroundMap,
} from "@sweatbox/shared";
import { ITST_GROUND, registerTestAirport } from "@sweatbox/shared/testing/itst";
import { Session } from "../src/sim/session";
import { holdBack } from "../src/sim/ground";
import { HttpError } from "../src/errors";
import { config } from "@sweatbox/config";

const U = 3.30714286;

/** A session running a sweatbox file; event lines alone get a default [sweatbox] section (IRFD). */
function session(script: string, rng = () => 0.5): Session {
  const s = new Session("TestAa", "host", rng);
  const text = /^\s*\[sweatbox\]\s*$/m.test(script) ? script : `[sweatbox]\nairport = IRFD\n${script}`;
  const r = s.loadScript("TEST", text);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  s.play();
  return s;
}

const run = (s: Session, n: number) => {
  for (let i = 0; i < n; i++) s.tick();
};

/** Run until predicate holds (or fail after max ticks). */
function until(s: Session, pred: () => boolean, max = 5000): number {
  for (let i = 0; i < max; i++) {
    if (pred()) return i;
    s.tick();
  }
  throw new Error(`condition not met after ${max} ticks\n${s.logEntries.map((l) => l.message).join("\n")}`);
}

const ac = (s: Session, cs: string) => s.byCallsign(cs)!;
const logs = (s: Session) => s.logEntries.map((l) => l.message);

function rejects(fn: () => unknown, text: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).message).toBe(text);
    return;
  }
  throw new Error(`expected rejection "${text}"`);
}

describe("airborne flight model", () => {
  it("climbs 25 ft/s, accelerates 6 kt/s, turns 3 deg/s and moves gs/3600 units per tick", () => {
    const s = session("[00:00] airborne: callsign=TST1 type=A320 position=0,0 altitude=5000 speed=200 level=FL300 route=HDG090 from=IRFD to=ITKO");
    run(s, 1); // spawn happens on the first tick (offset 0 <= elapsed 1) and the aircraft moves once
    const a = ac(s, "TST1");
    const p0 = { ...a.pos };
    a.assigned = { alt: 6000, heading: 120, speed: 250 };
    s.tick();
    expect(a.altitude).toBe(5025);
    expect(a.groundSpeed).toBe(206);
    expect(a.heading).toBeCloseTo(93);
    const moved = dist(p0, a.pos);
    expect(moved).toBeCloseTo(206 / 3600, 9);
    run(s, 9);
    expect(a.heading).toBeCloseTo(120); // 30 degrees in 10 s, snapped
  });

  it("turns the shorter way", () => {
    const s = session("[00:00] airborne: callsign=TST1 type=A320 position=0,0 altitude=5000 speed=200 level=FL300 route=HDG010 from=IRFD to=ITKO");
    run(s, 1);
    const a = ac(s, "TST1");
    a.assigned.heading = 340;
    s.tick();
    expect(a.heading).toBeCloseTo(7);
  });

  it("caps the speed at 250 kt when assigned 3000 ft or below", () => {
    const s = session("[00:00] airborne: callsign=TST1 type=A320 position=0,0 altitude=5000 speed=300 level=FL300 route=HDG010 from=IRFD to=ITKO\n[00:01] assign: callsign=TST1 altitude=3000");
    run(s, 3);
    expect(ac(s, "TST1").assigned.speed).toBe(250);
  });

  it("flies a fix list and pops fixes within 0.5 units", () => {
    const s = session("[00:00] airborne: callsign=TST1 type=A320 position=25,-5 altitude=5000 speed=250 level=FL300 route=ANTNY,ROMNS from=IRFD to=IRFD");
    run(s, 1);
    const a = ac(s, "TST1");
    expect(a.fixList.map((f) => f.name)).toEqual(["ANTNY", "ROMNS"]);
    until(s, () => a.fixList.length === 1);
    expect(dist(a.pos, { x: 19, y: -12.5 })).toBeLessThanOrEqual(0.5);
  });

  it("homes to the destination and is removed as ARRIVED within 2 NM", () => {
    const s = session("[00:00] airborne: callsign=TST1 type=A320 position=5,25 altitude=5000 speed=250 level=FL300 route=MDWST from=IRFD to=ITKO");
    until(s, () => logs(s).some((l) => l.startsWith("ARRIVED TST1 ITKO")), 20000);
    expect(s.counters.arrived).toBe(1);
    expect(s.byCallsign("TST1")).toBeUndefined();
  });
});

describe("approaches and landing", () => {
  it("captures the ILS from an intercept heading, follows the glidepath and lands", () => {
    const end = findRunwayEnd("IRFD-25L")!;
    const a0 = appr(end);
    // 12 NM final, 3 NM left of the centreline, heading 30 degrees to the final course
    const p = add(add(a0.threshold, scale(a0.out, 12 * U)), scale({ x: -a0.out.y, y: a0.out.x }, -3 * U));
    const s = session(`[00:00] airborne: callsign=TST2 type=A320 position=${p.x},${p.y} altitude=4000 speed=210 level=FL300 route=HDG${Math.round(a0.course - 30)} from=ITKO to=IRFD\n[00:01] approach: callsign=TST2 runway=IRFD-25L`);
    run(s, 2);
    const a = ac(s, "TST2");
    expect(a.approach).toBe("IRFD-25L");
    until(s, () => a.apprCaptured, 2000);
    let maxDev = 0;
    let checkedGlide = false;
    until(
      s,
      () => {
        if (a.gone || !s.byCallsign("TST2")) return true;
        const d = alongTrackNm(a0, a.pos);
        if (d < 6 && d > 1) {
          maxDev = Math.max(maxDev, Math.abs(a.heading - a0.course));
          const glide = d * 6076.12 * Math.tan((3 * Math.PI) / 180);
          expect(Math.abs(a.altitude - glide)).toBeLessThan(400);
          checkedGlide = true;
        }
        if (d < 1.9 && d > 0.5) expect(a.assigned.speed).toBeLessThanOrEqual(130);
        return false;
      },
      3000,
    );
    expect(checkedGlide).toBe(true);
    expect(maxDev).toBeLessThan(5);
    expect(logs(s)).toContain("LANDED TST2 IRFD-25L");
    expect(s.counters.landed).toBe(1);
  });

  it("host APPR is refused more than 40 degrees off the final course", () => {
    const s = session("[00:00] airborne: callsign=TST3 type=A320 position=30,5 altitude=4000 speed=210 level=FL300 route=HDG090 from=ITKO to=IRFD");
    run(s, 1);
    const a = ac(s, "TST3");
    rejects(() => s.hostControl("air", a.id, { appr: "IRFD-25L" }), "More than 40° off the IRFD-25L final course");
    s.hostControl("air", a.id, { hdg: 230 });
    expect(s.hostControl("air", a.id, { appr: "IRFD-25L" }).approach).toBe("IRFD-25L");
    expect(logs(s)).toContain("HOST APPR TST3 → IRFD-25L");
    expect(s.counters.hostCmds).toEqual({ HDG: 1, APPR: 1 });
  });

  it("host instructions on the ground are refused for airborne actions", () => {
    registerTestAirport();
    const s = session("[00:00] parked: callsign=TGND1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST");
    run(s, 1);
    rejects(() => s.hostControl("air", ac(s, "TGND1").id, { alt: 5000 }), "Aircraft is on the ground");
  });
});

describe("TWR mode", () => {
  const finalScript = (cs: string, nm: number) => {
    const end = findRunwayEnd("IRFD-25L")!;
    const a0 = appr(end);
    const p = add(a0.threshold, scale(a0.out, nm * U));
    return `[00:00] airborne: callsign=${cs} type=A320 position=${p.x},${p.y} altitude=${Math.round(nm * 318)} speed=140 level=FL300 route=HDG${Math.round(a0.course)} from=ITKO to=IRFD\n[00:00] approach: callsign=${cs} runway=IRFD-25L`;
  };

  it("goes around at 0.6 NM without a landing clearance, then flies a circuit back", () => {
    const s = session(`[sweatbox]\nairport = IRFD\nview = TWR\n${finalScript("TWR1", 4)}`);
    run(s, 1);
    expect(s.twrMode).toBe(true);
    expect(logs(s)).toContain("TWR open: arrivals need landing clearance");
    const a = ac(s, "TWR1");
    until(s, () => logs(s).some((l) => l.startsWith("GO AROUND TWR1")), 3000);
    const end = findRunwayEnd("IRFD-25L")!;
    expect(alongTrackNm(appr(end), a.pos)).toBeLessThanOrEqual(0.62);
    expect(a.cct).not.toBeNull();
    expect(a.cct!.leg).toBe("up");
    expect(a.cct!.alt).toBe(1500); // non-GA type
    expect(a.cct!.spd).toBe(160);
    expect(s.counters.landed).toBe(0);
  });

  it("lands with a landing clearance", () => {
    const s = session(`[sweatbox]\nairport = IRFD\nview = TWR\n${finalScript("TWR2", 4)}`);
    run(s, 2);
    const a = ac(s, "TWR2");
    s.hostControl("twr", a.id, { action: "land" });
    expect(logs(s)).toContain("CLEARED TO LAND TWR2 IRFD-25L");
    until(s, () => !s.byCallsign("TWR2"), 3000);
    expect(logs(s)).toContain("LANDED TWR2 IRFD-25L");
  });

  it("CTR mode go-around: runway heading, 3000 ft, at least 180 kt", () => {
    const s = session(finalScript("GA1", 4));
    run(s, 2);
    const a = ac(s, "GA1");
    s.hostControl("twr", a.id, { action: "ga" });
    expect(a.assigned.alt).toBe(3000);
    expect(a.assigned.speed).toBeGreaterThanOrEqual(180);
    expect(a.assigned.heading).toBe(Math.round(rwyEnd(findRunwayEnd("IRFD-25L")!).heading));
    expect(a.cct).toBeNull();
  });

  it("toggle via the API logs only on change", () => {
    const s = session("[00:00] message: text=x");
    s.setTwr(true);
    s.setTwr(true);
    s.setTwr(false);
    expect(logs(s).filter((l) => l.startsWith("TWR"))).toEqual([
      "TWR open: arrivals need landing clearance",
      "TWR closed: landing clearance no longer required",
    ]);
  });
});

describe("departures", () => {
  it("DEP spawns 60% down the runway at 200 ft / 160 kt and joins its route passing 1000 ft", () => {
    const s = session("[00:00] departing: callsign=DEP1 type=A320 runway=IRFD-25R climb=4000 level=FL240 route=HDG200 to=ISAU");
    run(s, 1);
    const a = ac(s, "DEP1");
    const g = rwyEnd(findRunwayEnd("IRFD-25R")!);
    expect(a.altitude).toBeGreaterThanOrEqual(200);
    expect(a.altitude).toBeLessThanOrEqual(225);
    expect(Math.round(a.heading)).toBe(g.heading);
    expect(a.assigned.speed).toBe(250);
    expect(a.assigned.heading).toBe(g.heading);
    until(s, () => a.altitude >= 1000);
    s.tick();
    expect(a.assigned.heading).toBe(200);
    expect(a.dep!.joined).toBe(true);
  });

  it("a host heading before 1000 ft stops the route join", () => {
    const s = session("[00:00] departing: callsign=DEP2 type=A320 runway=IRFD-25R climb=4000 level=FL240 route=HDG200 to=ISAU");
    run(s, 2);
    const a = ac(s, "DEP2");
    s.hostControl("air", a.id, { hdg: 300 });
    until(s, () => a.altitude >= 1100);
    expect(a.assigned.heading).toBe(300);
  });

  it("a fix route after takeoff becomes the fix list", () => {
    const s = session("[00:00] departing: callsign=DEP3 type=A320 runway=IRFD-25R climb=4000 level=FL240 route=MOGTA to=IRFD");
    until(s, () => (s.byCallsign("DEP3")?.altitude ?? 0) >= 1000);
    s.tick();
    expect(ac(s, "DEP3").fixList.map((f) => f.name)).toEqual(["MOGTA"]);
  });

  it("a route that starts behind the departure is joined only at the cleared altitude", () => {
    // MDWST is east of the field: no U-turn over the airport at 1000 ft
    const s = session("[00:00] departing: callsign=DEP4 type=A320 runway=IRFD-25R climb=3000 level=FL240 route=MDWST to=IRFD");
    until(s, () => (s.byCallsign("DEP4")?.altitude ?? 0) >= 1500);
    expect(ac(s, "DEP4").fixList).toEqual([]);
    expect(ac(s, "DEP4").heading).toBeCloseTo(247, 0);
    until(s, () => ac(s, "DEP4").fixList.length > 0);
    expect(ac(s, "DEP4").altitude).toBeGreaterThanOrEqual(2950);
  });
});

describe("holds", () => {
  it("holds at a fix, stays near it, and resumes the route on xhold", () => {
    const s = session("[00:00] airborne: callsign=HLD1 type=A320 position=30,-5 altitude=6000 speed=220 level=FL300 route=ANTNY,ROMNS from=IRFD to=IRFD");
    run(s, 1);
    const a = ac(s, "HLD1");
    s.hostControl("twr", a.id, { action: "hold", fix: "ANTNY", turn: "L", leg: 60 });
    expect(a.hold!.dir).toBe("L");
    until(s, () => a.hold!.ph === "out", 3000);
    let far = 0;
    run(s, 600);
    for (let i = 0; i < 600; i++) {
      s.tick();
      far = Math.max(far, dist(a.pos, { x: 19, y: -12.5 }) / U);
    }
    expect(far).toBeLessThan(7);
    expect(a.hold).not.toBeNull();
    s.hostControl("twr", a.id, { action: "xhold" });
    expect(a.hold).toBeNull();
    expect(a.fixList.map((f) => f.name)).toEqual(["ROMNS"]);
  });

  it("refuses unknown fixes and leaving a hold that doesn't exist", () => {
    const s = session("[00:00] airborne: callsign=HLD2 type=A320 position=30,-5 altitude=6000 speed=220 level=FL300 route=HDG090 from=IRFD to=IRFD");
    run(s, 1);
    const a = ac(s, "HLD2");
    rejects(() => s.hostControl("twr", a.id, { action: "hold", fix: "NOPE" }), "Unknown fix NOPE");
    rejects(() => s.hostControl("twr", a.id, { action: "xhold" }), "Not holding");
    s.hostControl("twr", a.id, { action: "hold" });
    expect(a.hold!.fix).toBe("PPOS");
    s.hostControl("air", a.id, { hdg: 180 });
    expect(a.hold).toBeNull();
  });
});

describe("circuits", () => {
  it("flies upwind, crosswind, downwind, base, final and touches and goes", () => {
    const g = rwyEnd(findRunwayEnd("IRFD-25C")!);
    const p = add(g.start, scale(g.dir, g.length * 0.6));
    const s = session(`[00:00] airborne: callsign=CCT1 type=C172 position=${p.x},${p.y} altitude=500 speed=80 level=FL010 route=HDG${g.heading} from=IRFD to=IRFD\n[00:00] circuit: callsign=CCT1 runway=IRFD-25C side=left join=upwind`);
    run(s, 1);
    const a = ac(s, "CCT1");
    const legs: string[] = [];
    until(
      s,
      () => {
        const leg = a.cct?.leg;
        if (leg && legs[legs.length - 1] !== leg) legs.push(leg);
        return logs(s).some((l) => l.startsWith("TOUCH AND GO CCT1"));
      },
      4000,
    );
    // ... and back to upwind after the touch-and-go
    expect(legs).toEqual(["up", "cross", "down", "base", "final", "up"]);
    expect(a.cct!.leg).toBe("up");
    expect(a.cct!.spd).toBe(90);
    expect(s.byCallsign("CCT1")).toBeDefined();
  });

  it("extends the downwind and turns base on request", () => {
    const g = rwyEnd(findRunwayEnd("IRFD-25C")!);
    const p = add(g.start, scale(g.dir, g.length * 0.6));
    const s = session(`[00:00] airborne: callsign=CCT2 type=C172 position=${p.x},${p.y} altitude=1000 speed=90 level=FL010 route=HDG${g.heading} from=IRFD to=IRFD\n[00:00] circuit: callsign=CCT2 runway=IRFD-25C side=left type=full-stop join=upwind`);
    run(s, 1);
    const a = ac(s, "CCT2");
    until(s, () => a.cct!.leg === "down", 3000);
    s.hostControl("twr", a.id, { action: "tng" });
    expect(a.cct!.tng).toBe(true);
    s.hostControl("twr", a.id, { action: "tng" });
    expect(a.cct!.tng).toBe(false);
    s.hostControl("twr", a.id, { action: "ext" });
    expect(a.cct!.ext).toBe(true);
    run(s, 200);
    expect(a.cct!.leg).toBe("down"); // still extended
    s.hostControl("twr", a.id, { action: "ext" }); // turn now
    expect(a.cct!.leg).toBe("base");
    expect(a.cct!.ext).toBe(false);
    rejects(() => s.hostControl("twr", a.id, { action: "ext" }), "Only the upwind, crosswind or downwind leg can be extended");
    until(s, () => !s.byCallsign("CCT2"), 3000);
    expect(logs(s)).toContain("LANDED CCT2 IRFD-25C");
  });

  it("chooses the pattern side away from parallel runways", async () => {
    const { defaultPatternSide } = await import("../src/sim/circuit");
    // 25C has parallels on both sides -> left; 25R / 25L have parallels on one side only
    expect(defaultPatternSide("IRFD-25C")).toBe("L");
    expect(["L", "R"]).toContain(defaultPatternSide("IRFD-25R"));
    expect(defaultPatternSide("IRFD-25R")).not.toBe(defaultPatternSide("IRFD-25L"));
    expect(defaultPatternSide("IPAP-17")).toBe("L"); // single runway
  });
});

describe("separation, emergencies, deletion", () => {
  it("counts a separation loss once per pair until resolved", () => {
    const s = session("[00:00] airborne: callsign=SEP1 type=A320 position=0,0 altitude=5000 speed=250 level=FL300 route=HDG090 from=IRFD to=ITKO\n[00:00] airborne: callsign=SEP2 type=A320 position=0,3 altitude=5500 speed=250 level=FL300 route=HDG090 from=IRFD to=ITKO");
    run(s, 30);
    expect(s.counters.separationLosses).toBe(1);
    expect(logs(s).filter((l) => l.startsWith("SEPARATION LOSS SEP1/SEP2")).length).toBe(1);
    ac(s, "SEP2").assigned.alt = 9000;
    run(s, 200);
    ac(s, "SEP2").assigned.alt = 5000;
    run(s, 200);
    expect(s.counters.separationLosses).toBe(2);
  });

  it("emergencies count once, deletes are counted", () => {
    const s = session("[00:00] airborne: callsign=EM1 type=A320 position=0,0 altitude=5000 speed=250 level=FL300 route=HDG090 from=IRFD to=ITKO\n[00:01] emergency: callsign=EM1\n[00:02] emergency: callsign=EM1\n[00:03] emergency: callsign=EM1");
    run(s, 5);
    expect(s.counters.emergencies).toBe(1);
    s.hostControl("air", ac(s, "EM1").id, { del: true });
    expect(s.byCallsign("EM1")).toBeUndefined();
    const st = s.stats();
    expect(st.deleted).toBe(1);
    expect(st.hostInstructions).toBe(0); // DEL / EMER don't count
    expect(st.hostBreakdown).toEqual({ DEL: 1 });
  });
});

describe("ground (ITST test airport)", () => {
  beforeAll(() => {
    registerTestAirport();
  });

  it("parks, pushes, taxis to a hold, lines up and takes off", () => {
    const s = session("[00:00] parked: callsign=GND1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST\n[00:00] climb: callsign=GND1 altitude=4000");
    run(s, 1);
    const a = ac(s, "GND1");
    expect(a.onGround).toBe(true);
    expect(a.gnd!.mode).toBe("stand");
    expect(a.heading).toBe(180);
    expect(a.gnd!.pushFacing.map((o) => o.hdg).sort()).toEqual([270, 90]);
    rejects(() => s.hostControl("gnd", a.id, { action: "taxi", route: ["D"], target: "" }), "Push back first");
    rejects(() => s.hostControl("gnd", a.id, { action: "tkof", runway: "ITST-09" }), "Push back first");
    s.hostControl("gnd", a.id, { action: "push", facing: 90 });
    expect(a.gnd!.status).toBe("PUSHING, FACE 090");
    // taxi while pushing: queued
    s.hostControl("gnd", a.id, { action: "taxi", route: ["D", "C", "A", "B1"], target: "H:B1 09/27" });
    until(s, () => a.gnd!.mode === "taxi");
    expect(a.gnd!.status).toBe("TAXI VIA D C A B1 → HOLD SHORT 09/27");
    expect(Math.round(a.heading)).toBe(90);
    until(s, () => a.gnd!.mode === "holding", 3000);
    expect(a.gnd!.status).toBe("HOLDING SHORT 09/27 AT B1");
    // stopped with the nose short of the red line (the bar is at y = 0.1, the runway to the north)
    expect(a.pos.x).toBeCloseTo(0, 4);
    expect(a.pos.y).toBeCloseTo(0.1 + holdBack(a), 3);
    expect(a.pos.y - lengthUnits(a.type) / 2).toBeGreaterThan(0.1);
    rejects(() => s.hostControl("gnd", a.id, { action: "tkof", runway: "ITST-99" }), "Unknown runway ITST-99");
    s.hostControl("gnd", a.id, { action: "tkof", runway: "ITST-09", wait: true });
    until(s, () => a.gnd!.mode === "lined", 1000);
    expect(Math.round(a.heading)).toBe(90);
    rejects(() => s.hostControl("gnd", a.id, { action: "tkof", runway: "ITST-09", wait: true }), "Already lined up");
    s.hostControl("gnd", a.id, { action: "tkof", runway: "ITST-09" });
    until(s, () => !a.onGround, 1000);
    expect(logs(s)).toContain("DEPARTED GND1 ITST-09");
    expect(a.altitude).toBeGreaterThanOrEqual(200);
    expect(a.assigned.alt).toBe(4000); // from CLMB
    expect(s.counters.hostCmds.GND).toBe(4);
  });

  it("joins the first taxiway of a clearance from where the aircraft is (via A from taxiway D)", () => {
    const s = session("[00:00] parked: callsign=JOIN1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST");
    run(s, 1);
    const a = ac(s, "JOIN1");
    s.hostControl("gnd", a.id, { action: "push", facing: 270 });
    until(s, () => a.gnd!.mode === "holding", 1000);
    s.hostControl("gnd", a.id, { action: "taxi", route: ["A"], target: "H:B1 09/27" });
    until(s, () => a.gnd!.mode === "holding", 3000);
    expect(a.gnd!.status).toBe("HOLDING SHORT 09/27 AT B1");
  });

  it("refuses taxiways that don't join and takeoffs far from the runway", () => {
    const s = session("[00:00] parked: callsign=GND2 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST");
    run(s, 1);
    const a = ac(s, "GND2");
    s.hostControl("gnd", a.id, { action: "push", facing: 270 });
    until(s, () => a.gnd!.mode === "holding", 1000);
    rejects(() => s.hostControl("gnd", a.id, { action: "taxi", route: ["D", "B1"], target: "" }), "D doesn't join B1, add the taxiway between them");
    rejects(() => s.hostControl("gnd", a.id, { action: "taxi", route: [], target: "" }), "Pick taxiways (or a stand)");
    rejects(() => s.hostControl("gnd", a.id, { action: "taxi", route: [], target: "H:Q9" }), "Unknown hold Q9");
    rejects(() => s.hostControl("gnd", a.id, { action: "taxi", route: [], target: "S:99" }), "Unknown stand 99");
    rejects(() => s.hostControl("gnd", a.id, { action: "taxi", route: ["D"], target: "T:ZZ" }), "Unknown taxiway ZZ");
    rejects(() => s.hostControl("gnd", a.id, { action: "tkof", runway: "ITST-09" }), "Too far from ITST-09: taxi to a hold first");
    rejects(() => s.hostControl("gnd", a.id, { action: "stop" }), "Not moving");
    rejects(() => s.hostControl("gnd", a.id, { action: "cont" }), "Not holding position");
    // shortest path to a hold, then stop / continue
    s.hostControl("gnd", a.id, { action: "taxi", route: [], target: "H:B2 09/27" });
    run(s, 5);
    s.hostControl("gnd", a.id, { action: "stop" });
    expect(a.gnd!.status).toMatch(/^HOLD POSITION \(TAXI → HOLD SHORT 09\/27\)$/);
    rejects(() => s.hostControl("gnd", a.id, { action: "stop" }), "Already holding position");
    run(s, 10);
    expect(a.groundSpeed).toBe(0);
    s.hostControl("gnd", a.id, { action: "cont" });
    until(s, () => a.gnd!.mode === "holding", 3000);
    expect(a.gnd!.status).toBe("HOLDING SHORT 09/27 AT B2");
  });

  it("stops on the hold bar before crossing a runway until CONT, and taxis to N:<node>", () => {
    const s = session("[00:00] parked: callsign=XNG1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST");
    run(s, 1);
    const a = ac(s, "XNG1");
    s.hostControl("gnd", a.id, { action: "push", facing: 90 });
    until(s, () => a.gnd!.mode === "holding", 1000);
    s.hostControl("gnd", a.id, { action: "taxi", route: ["D", "C", "X"], target: "N:21" });
    until(s, () => a.gnd!.paused, 3000);
    expect(a.gnd!.status).toBe("HOLD SHORT 09/27");
    // short of the hold bar (y = 0.1), the nose behind the red line
    const before = { x: 1.5, y: 0.1 + holdBack(a) };
    expect(dist(a.pos, before)).toBeLessThan(0.002);
    run(s, 30);
    expect(dist(a.pos, before)).toBeLessThan(0.002); // still waiting
    s.hostControl("gnd", a.id, { action: "cont" });
    expect(a.gnd!.status).toBe("TAXI VIA D C X → POINT 21");
    until(s, () => a.gnd!.mode === "holding", 3000);
    expect(dist(a.pos, { x: 1.5, y: -0.2 })).toBeLessThan(0.002);
    rejects(() => s.hostControl("gnd", a.id, { action: "taxi", route: [], target: "N:999" }), "Unknown point");
  });

  it("lines up on the centreline from an entry on the runway edge", () => {
    const s = session("[00:00] parked: callsign=LUP1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST");
    run(s, 1);
    const a = ac(s, "LUP1");
    s.hostControl("gnd", a.id, { action: "push", facing: 270 });
    s.hostControl("gnd", a.id, { action: "taxi", route: ["D", "C", "A", "B1"], target: "H:B1 09/27" });
    until(s, () => a.gnd!.mode === "holding" && a.gnd!.status.startsWith("HOLDING SHORT"), 4000);
    s.hostControl("gnd", a.id, { action: "tkof", runway: "ITST-09", wait: true });
    until(s, () => a.gnd!.mode === "lined", 1000);
    expect(Math.abs(a.pos.y)).toBeLessThan(0.001);
    expect(Math.round(a.heading)).toBe(90);
  });

  it("never lines up from a crossing-only hold", () => {
    // ITST moved 40 units east as "ITSC", with no entries published for X: its hold bars only guard the crossing
    const off = ([x, y]: [number, number]): [number, number] => [x + 40, y];
    const g0 = ITST_GROUND.ground;
    const data: RoutableGroundMap = {
      ...ITST_GROUND,
      icao: "ITSC",
      ground: {
        nodes: g0.nodes.map(off),
        edges: g0.edges.map((e) => ({ ...e, pts: e.pts.map(off) })),
        holds: g0.holds,
        entries: g0.entries.filter((e) => e.twy !== "X"),
        stands: g0.stands.map((st) => ({ ...st, line: st.line.map(off) })),
      },
    };
    registerAirport({ code: "ITSC", name: "Test Crossing", iata: "", freqs: {}, topDowns: [], centre: [41, 0], runways: ["09/27"], depRunways: [] });
    registerRunwayPair({ icao: "ITSC", name1: "ITSC-09", name2: "ITSC-27", position1: { x: 40, y: 0 }, position2: { x: 42, y: 0 }, pair: "09/27" });
    registerGroundMapData("ITSC", data);
    registerGroundGraph(buildGroundGraph(data, "ITSC"));

    const s = session("[00:00] parked: callsign=COX1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITSC");
    run(s, 1);
    const a = ac(s, "COX1");
    s.hostControl("gnd", a.id, { action: "push", facing: 90 });
    s.hostControl("gnd", a.id, { action: "taxi", route: ["D", "C", "X"], target: "H:X 09/27 S" });
    until(s, () => a.gnd!.mode === "holding" && a.gnd!.status.startsWith("HOLDING SHORT"), 4000);
    rejects(() => s.hostControl("gnd", a.id, { action: "tkof", runway: "ITSC-09" }), "X 09/27 S is only for crossing, no line-up from there");
  });

  it("keeps a one-aircraft-length gap behind traffic", () => {
    const s = session("[00:00] parked: callsign=SP1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST\n[00:00] parked: callsign=SP2 type=A320 stand=2 level=FL300 route=HDG090 to=IRFD airport=ITST");
    run(s, 1);
    const lead = ac(s, "SP1");
    const foll = ac(s, "SP2");
    s.hostControl("gnd", lead.id, { action: "push", facing: 270 });
    s.hostControl("gnd", lead.id, { action: "taxi", route: ["D", "C", "A", "B1"], target: "H:B1 09/27" });
    // push the second aircraft only once the first is clear of its stand, on taxiway C
    until(s, () => lead.pos.x <= 0.5 && lead.pos.y < 0.39, 3000);
    s.hostControl("gnd", foll.id, { action: "push", facing: 270 });
    s.hostControl("gnd", foll.id, { action: "taxi", route: ["D", "C", "A", "B1"], target: "H:B1 09/27" });
    let minGap = Infinity;
    let spaced = false;
    until(
      s,
      () => {
        // gap measured along the follower's taxi path (spacing is nose-to-tail along the route)
        if (foll.gnd?.mode === "taxi") {
          const proj = projectOnPolyline(lead.pos, [foll.pos, ...foll.gnd.path.map((p) => p.p)]);
          if (proj.lateral < 0.01) minGap = Math.min(minGap, proj.along);
        }
        spaced ||= Boolean(foll.gnd?.spacing);
        return lead.gnd!.mode === "holding" && foll.gnd!.mode === "taxi" && foll.groundSpeed === 0;
      },
      5000,
    );
    const len = 37.6 / 560;
    expect(spaced).toBe(true);
    expect(minGap).toBeGreaterThanOrEqual(len * 2 - 0.01);
  });

  it("follow refuses loops and strangers", () => {
    const s = session("[00:00] parked: callsign=F1 type=A320 stand=1 level=FL300 route=HDG090 to=IRFD airport=ITST\n[00:00] parked: callsign=F2 type=A320 stand=2 level=FL300 route=HDG090 to=IRFD airport=ITST\n[00:00] airborne: callsign=F3 type=A320 position=0,0 altitude=3000 speed=200 level=FL300 route=HDG090 from=IRFD to=ITKO");
    run(s, 1);
    const [f1, f2, f3] = ["F1", "F2", "F3"].map((c) => ac(s, c));
    rejects(() => s.hostControl("gnd", f1!.id, { action: "follow", leader: f2!.id }), "Push back first");
    s.hostControl("gnd", f1!.id, { action: "push", facing: 270 });
    s.hostControl("gnd", f2!.id, { action: "push", facing: 90 });
    until(s, () => f1!.gnd!.mode === "holding" && f2!.gnd!.mode === "holding", 1000);
    rejects(() => s.hostControl("gnd", f1!.id, { action: "follow" }), "Pick an aircraft to follow");
    rejects(() => s.hostControl("gnd", f1!.id, { action: "follow", leader: f3!.id }), "F3 is not on the ground here");
    s.hostControl("gnd", f1!.id, { action: "follow", leader: f2!.id });
    expect(f1!.gnd!.status).toBe("FOLLOW F2");
    rejects(() => s.hostControl("gnd", f2!.id, { action: "follow", leader: f1!.id }), "F1 is following F2");
  });

  it("rolls out, vacates toward the stands, taxis to a free stand and is removed after 300 s", () => {
    const end = findRunwayEnd("ITST-27")!;
    const a0 = appr(end);
    const p = add(a0.threshold, scale(a0.out, 6 * U));
    const s = session(`[sweatbox]\nairport = IRFD\nafter landing = stand\n[00:00] airborne: callsign=ARR1 type=A320 position=${p.x},${p.y} altitude=1900 speed=140 level=FL300 route=HDG270 from=ITKO to=ITST\n[00:00] approach: callsign=ARR1 runway=ITST-27`);
    run(s, 2);
    const a = ac(s, "ARR1");
    until(s, () => a.onGround, 3000);
    expect(logs(s)).toContain("LANDED ARR1 ITST-27");
    expect(a.gnd!.mode).toBe("rollout");
    until(s, () => a.gnd!.mode !== "rollout", 1000);
    // vacated south (the stands' side) past the hold line, then straight on to a stand
    expect(a.pos.y).toBeGreaterThan(0.1);
    expect(a.gnd!.status).toMatch(/^TAXI → STAND [12]$/);
    until(s, () => a.gnd!.mode === "stand", 3000);
    expect(logs(s).some((l) => l.startsWith("ARR1 parked on stand ITST-"))).toBe(true);
    run(s, 299);
    expect(s.byCallsign("ARR1")).toBeDefined();
    run(s, 2);
    expect(s.byCallsign("ARR1")).toBeUndefined();
  });

  it("ROLLOUT HOLD vacates and stops half an aircraft length past the hold line", () => {
    const end = findRunwayEnd("ITST-27")!;
    const a0 = appr(end);
    const p = add(a0.threshold, scale(a0.out, 6 * U));
    const s = session(`[sweatbox]\nairport = IRFD\nafter landing = hold\n[00:00] airborne: callsign=ARR2 type=A320 position=${p.x},${p.y} altitude=1900 speed=140 level=FL300 route=HDG270 from=ITKO to=ITST\n[00:00] approach: callsign=ARR2 runway=ITST-27`);
    run(s, 2);
    const a = ac(s, "ARR2");
    until(s, () => a.onGround && a.gnd?.mode === "holding", 4000);
    expect(a.gnd!.status).toMatch(/^VACATED 27 VIA (A\/)?B[12]/);
    const len = 37.6 / 560;
    expect(a.pos.y).toBeGreaterThan(0.1 + len / 2 - 0.02);
    expect(a.pos.y).toBeLessThan(0.21);
    run(s, 400);
    expect(s.byCallsign("ARR2")).toBeDefined(); // HOLD mode stays put
  });

  it("ROLLOUT OFF makes landed aircraft vanish", () => {
    const end = findRunwayEnd("ITST-27")!;
    const a0 = appr(end);
    const p = add(a0.threshold, scale(a0.out, 6 * U));
    const s = session(`[00:00] airborne: callsign=ARR3 type=A320 position=${p.x},${p.y} altitude=1900 speed=140 level=FL300 route=HDG270 from=ITKO to=ITST\n[00:00] approach: callsign=ARR3 runway=ITST-27`);
    until(s, () => logs(s).includes("LANDED ARR3 ITST-27"), 4000);
    expect(s.byCallsign("ARR3")).toBeUndefined();
  });
});

/** Push back, then taxi to the first holding point of `rwy` there is a route to. */
const toHold = (s: Session, a: ReturnType<typeof ac>, rwy: string) => {
  const g = getGroundGraph(a.gnd!.apt)!;
  const pair = findRunwayEnd(rwy)!.pair.pair;
  // holding points to line up from (with a runway entry beside them), nearest first
  const holds = g.holds
    .filter((h) => samePair(h.rwy, pair) && entryNearHold(g, h))
    .sort((p, q) => dist(g.nodes[p.n]!, a.pos) - dist(g.nodes[q.n]!, a.pos));
  // push facing a way that leads to one of them (not into a dead end)
  const stand = g.standByName.get(a.gnd!.stand!)!;
  const facing = a.gnd!.pushFacing.find((o) => holds.some((h) => shortestPath(g, stand.j, h.n, { forbidFirstEdge: o.edge })));
  s.hostControl("gnd", a.id, { action: "push", ...(facing ? { facing: facing.hdg } : {}) });
  until(s, () => a.gnd!.mode === "holding", 600);
  for (const h of holds) {
    try {
      s.hostControl("gnd", a.id, { action: "taxi", route: [], target: `H:${h.name}` });
      return;
    } catch {
      // no route to that one: the next
    }
  }
  throw new Error(`no holding point for ${rwy} reachable from ${a.callsign}`);
};

describe("ground (IRFD)", () => {
  const ends = ["IRFD-07L", "IRFD-25R", "IRFD-07C", "IRFD-25C", "IRFD-07R", "IRFD-25L"];
  /** Run until pred, clearing the aircraft across each runway it stops short of (as a controller would). */
  const untilCrossing = (s: Session, a: ReturnType<typeof ac>, pred: () => boolean, max: number) =>
    until(
      s,
      () => {
        if (a.gnd?.paused && a.gnd.status.startsWith("HOLD SHORT ")) s.hostControl("gnd", a.id, { action: "cont" });
        return pred();
      },
      max,
    );

  it("every stand pushes back and taxis to a holding point, then lines up and takes off", () => {
    for (let k = 1; k <= 20; k++) {
      const rwy = ends[k % ends.length]!;
      const s = session(`[00:00] parked: callsign=DEP${k} type=A320 stand=${k} level=FL300 route=HDG090 to=IPPH`);
      run(s, 2);
      const a = ac(s, `DEP${k}`);
      toHold(s, a, rwy);
      untilCrossing(s, a, () => a.gnd!.mode === "holding" && a.gnd!.status.startsWith("HOLDING SHORT") && !a.gnd!.path.length, 6000);
      // stopped with the nose behind the red line
      const bar = getGroundGraph("IRFD")!.nodes[a.gnd!.node!]!;
      expect(dist(a.pos, bar), `stand ${k}`).toBeGreaterThanOrEqual(lengthUnits(a.type) / 2);
      expect(dist(a.pos, bar), `stand ${k}`).toBeLessThan(holdBack(a) + 0.002);
      s.hostControl("gnd", a.id, { action: "tkof", runway: rwy });
      until(s, () => !a.onGround, 3000);
    }
  });

  it("arrivals on every runway roll out, vacate and taxi to a stand", () => {
    for (const rwy of ends)
      for (const r of [0.05, 0.95]) {
        const a0 = appr(findRunwayEnd(rwy)!);
        const p = add(a0.threshold, scale(a0.out, 6 * U));
        const s = session(`[sweatbox]\nairport = IRFD\nafter landing = stand\n[00:00] airborne: callsign=ARR1 type=A320 position=${p.x},${p.y} altitude=1900 speed=140 level=FL300 route=HDG${String(Math.round(aviationAngle(scale(a0.out, -1)))).padStart(3, "0")} from=IPPH to=IRFD\n[00:00] approach: callsign=ARR1 runway=${rwy}`, () => r);
        run(s, 2);
        const a = ac(s, "ARR1");
        until(s, () => a.onGround, 3000);
        untilCrossing(s, a, () => a.gnd!.mode === "stand", 8000);
      }
  });

  it("DEL: every stand starts occupied; a cleared departure leaves a minute after its clearance", () => {
    const g = getGroundGraph("IRFD")!;
    const s = session(generateSweatbox({ apt: "IRFD", position: "DEL", runway: "25" }).text);
    expect(s.position).toBe("DEL");
    run(s, 2);
    const parked = s.aircraft.filter((x) => x.gnd?.mode === "stand");
    expect(parked.length).toBe(g.stands.length);
    // nothing moves without a clearance
    run(s, 120);
    expect(s.aircraft.filter((x) => x.gnd?.mode === "stand").length).toBe(g.stands.length);
    const [first, second] = parked as [ReturnType<typeof ac>, ReturnType<typeof ac>];
    s.setStrip(first.callsign, "c", "1");
    s.setStrip(second.callsign, "c", "1");
    run(s, 30);
    s.setStrip(second.callsign, "c", ""); // clearance taken back: it stays
    run(s, 29);
    expect(s.byCallsign(first.callsign)).toBeDefined();
    expect(first.gnd!.mode).toBe("stand"); // it never moves by itself
    run(s, 2);
    expect(s.byCallsign(first.callsign)).toBeUndefined();
    expect(s.byCallsign(second.callsign)).toBeDefined();
    // freed stands get the next aircraft from the queue
    run(s, config.ground.standRefillSec + 30);
    expect(s.counters.spawned).toBeGreaterThan(g.stands.length);
  });

  it("only DEL sweatboxes remove cleared aircraft", () => {
    const s = session(generateSweatbox({ apt: "IRFD", position: "GND", runway: "25" }).text);
    run(s, 2);
    const a = s.aircraft.find((x) => x.gnd?.mode === "stand")!;
    s.setStrip(a.callsign, "c", "1");
    run(s, 120);
    expect(s.byCallsign(a.callsign)).toBeDefined();
  });

  it("GND: every stand starts occupied and arrivals keep coming", () => {
    const g = getGroundGraph("IRFD")!;
    const s = session(generateSweatbox({ apt: "IRFD", position: "GND", runway: "25" }).text);
    run(s, 2);
    expect(s.aircraft.filter((x) => x.gnd?.mode === "stand").length).toBe(g.stands.length);
    // GND departures wait for the controller; arrivals land spaced out and vacate
    run(s, 20 * 60);
    expect(s.aircraft.filter((x) => x.gnd?.mode === "stand").length).toBe(g.stands.length);
    expect(logs(s).filter((l) => l.startsWith("LANDED")).length).toBeGreaterThanOrEqual(4);
    expect(logs(s).filter((l) => l.startsWith("SEPARATION LOSS"))).toEqual([]);
  });

  it("the generated GND sweatbox runs without trouble", () => {
    const sb = generateSweatbox({ apt: "IRFD", position: "GND", runway: "25" });
    const s = session(sb.text);
    run(s, 30 * 60);
    expect(logs(s).filter((l) => /error|cannot|unknown/i.test(l))).toEqual([]);
  });
});

describe("ground (IPPH)", () => {
  const ends = ["IPPH-29", "IPPH-11", "IPPH-33", "IPPH-15"];
  const cross = (s: Session, a: ReturnType<typeof ac>, pred: () => boolean, max: number) =>
    until(
      s,
      () => {
        if (a.gnd?.paused && a.gnd.status.startsWith("HOLD SHORT ")) s.hostControl("gnd", a.id, { action: "cont" });
        return pred();
      },
      max,
    );

  it("every stand pushes back and taxis to a holding point, then lines up and takes off", () => {
    const g = getGroundGraph("IPPH")!;
    expect(g.stands.length).toBe(35);
    g.stands.forEach((st, k) => {
      const rwy = ends[k % ends.length]!;
      const s = session(`[sweatbox]
airport = IPPH
[00:00] parked: callsign=DEP${k} type=A320 stand=${st.name} level=FL300 route=ROM,GAVIN,SETHR to=IRFD`);
      run(s, 2);
      const a = ac(s, `DEP${k}`);
      toHold(s, a, rwy);
      cross(s, a, () => a.gnd!.mode === "holding" && a.gnd!.status.startsWith("HOLDING SHORT") && !a.gnd!.path.length, 8000);
      const bar = g.nodes[a.gnd!.node!]!;
      expect(dist(a.pos, bar), `stand ${st.name}`).toBeLessThan(holdBack(a) + 0.002);
      s.hostControl("gnd", a.id, { action: "tkof", runway: rwy });
      until(s, () => !a.onGround, 3000);
    });
  });

  it("arrivals on every runway roll out, vacate and taxi to a stand", () => {
    for (const rwy of ends)
      for (const r of [0.05, 0.95]) {
        const a0 = appr(findRunwayEnd(rwy)!);
        const p = add(a0.threshold, scale(a0.out, 6 * U));
        const s = session(`[sweatbox]
airport = IPPH
after landing = stand
[00:00] airborne: callsign=ARR1 type=A320 position=${p.x},${p.y} altitude=1900 speed=140 level=FL300 route=HDG${String(Math.round(aviationAngle(scale(a0.out, -1)))).padStart(3, "0")} from=IRFD to=IPPH
[00:00] approach: callsign=ARR1 runway=${rwy}`, () => r);
        run(s, 2);
        const a = ac(s, "ARR1");
        until(s, () => a.onGround, 3000);
        cross(s, a, () => a.gnd!.mode === "stand", 8000);
      }
  });

  it("DEL and GND sweatboxes are generated for Perth", () => {
    for (const position of ["DEL", "GND"] as const) {
      const s = session(generateSweatbox({ apt: "IPPH", position, runway: "29" }).text);
      run(s, 2);
      expect(s.aircraft.filter((x) => x.gnd?.mode === "stand").length, position).toBe(35);
      run(s, 10 * 60);
      expect(logs(s).filter((l) => /error|cannot|unknown|no route|not parked/i.test(l)), position).toEqual([]);
    }
  });
});

describe("takeoff release, routes, TWR clearances", () => {
  const parked = (n: number, from = 1) =>
    Array.from({ length: n }, (_, k) => `[00:00] parked: callsign=TK${k + 1} type=A320 stand=${from + k} level=FL240 route=MOGTA to=IGAR`).join("\n");
  const header = "[sweatbox]\nairport = IRFD\nview = GND\ndeparture runway = 25L\narrival runways = 25C, 25R\n";

  it("one takeoff at a time: the next rolls only once the one before is airborne above 100 ft", () => {
    // two holding points, two parallel runways (TK2 crosses 25L to 25C when told to)
    const s = session(`${header}${parked(2)}`);
    run(s, 2);
    toHold(s, ac(s, "TK1"), "IRFD-25L");
    toHold(s, ac(s, "TK2"), "IRFD-25C");
    until(
      s,
      () => {
        const b = ac(s, "TK2");
        if (b.gnd?.paused && b.gnd.status.startsWith("HOLD SHORT")) s.hostControl("gnd", b.id, { action: "cont" });
        return ["TK1", "TK2"].every((cs) => ac(s, cs).gnd?.mode === "holding" && !ac(s, cs).gnd!.path.length);
      },
      4000,
    );
    s.hostControl("gnd", ac(s, "TK1").id, { action: "tkof", runway: "IRFD-25L" });
    s.hostControl("gnd", ac(s, "TK2").id, { action: "tkof", runway: "IRFD-25C" });
    const rolled: string[] = [];
    let waited = false;
    until(
      s,
      () => {
        for (const cs of ["TK1", "TK2"]) {
          const x = ac(s, cs);
          if (x.gnd?.mode === "takeoff" && x.groundSpeed === 0 && /WAITING FOR TK/.test(x.gnd.status)) waited = true;
          if (!rolled.includes(cs) && x.gnd?.mode === "takeoff" && x.groundSpeed > 0) {
            rolled.push(cs);
            if (rolled.length === 2) {
              // the one before is off the ground and through 100 ft
              const first = ac(s, rolled[0]!);
              expect(first.onGround).toBe(false);
              expect(first.altitude).toBeGreaterThanOrEqual(100);
            }
          }
        }
        return rolled.length === 2;
      },
      4000,
    );
    expect(waited).toBe(true);
  });

  it("a departure flies its fix route toward its destination and is removed close to it", () => {
    const s = session("[00:00] departing: callsign=QFA1 type=B738 runway=25L climb=3000 level=FL240 route=SETHR,GAVIN,VOX to=IPPH");
    let landed = false;
    run(s, 1);
    until(
      s,
      () => {
        const x = s.byCallsign("QFA1");
        if (x?.approach) landed = true;
        return !x;
      },
      4000,
    );
    expect(landed).toBe(false); // nothing lands by itself
    expect(logs(s)).toContain("ARRIVED QFA1 IPPH");
    expect(s.counters.arrived).toBe(1);
  });

  it("TWR mode asks for landing clearances only on the session airport's runways", () => {
    const s = session(
      "[sweatbox]\nairport = IRFD\nview = TWR\n" +
        "[00:00] airborne: callsign=AWAY1 type=A320 position=36,-14 altitude=2000 speed=160 level=FL050 route=HDG290 from=IRFD to=IPPH\n" +
        "[00:00] approach: callsign=AWAY1 runway=IPPH-29",
    );
    run(s, 1);
    expect(s.twrMode).toBe(true);
    until(s, () => !s.byCallsign("AWAY1"), 3000);
    expect(logs(s).some((l) => l.startsWith("LANDED AWAY1 IPPH-29"))).toBe(true);
    expect(logs(s).some((l) => l.startsWith("GO AROUND AWAY1"))).toBe(false);
  });

  it("the showcase file loads and runs without warnings", () => {
    const text = fs.readFileSync(path.resolve(__dirname, "../../../data/scenarios/CTR-IRFD-SHOWCASE.sbx"), "utf8");
    const s = session(text);
    run(s, 8 * 60);
    expect(logs(s).filter((l) => /error|cannot|unknown|not parked|no route/i.test(l))).toEqual([]);
    expect(s.logEntries.filter((l) => l.level === "warn" && !/^SEPARATION LOSS/.test(l.message))).toEqual([]);
    // two in the Mellor circuit, departures off 25L, everyone else on a fix route
    expect(s.aircraft.filter((x) => x.cct?.rwy === "IMLR-25").length).toBe(2);
    expect(s.aircraft.filter((x) => !x.cct && !/^[A-Z0-9]{2,5}(,[A-Z0-9]{2,5})*$/.test(x.fp.route))).toEqual([]);
  }, 60_000);

  it("going around (climbing away) below 100 ft is not a landing", () => {
    const s = session(
      "[00:00] airborne: callsign=GA1 type=C172 position=0,0 altitude=80 speed=90 level=FL010 route=HDG247 from=IRFD to=IRFD\n[00:00] assign: callsign=GA1 altitude=1500",
    );
    run(s, 3);
    expect(s.byCallsign("GA1")).toBeDefined();
    expect(logs(s).some((l) => l.startsWith("LANDED"))).toBe(false);
  });
});

describe("script loading, CMD broadcast, replay", () => {
  it("rejects a bad script and keeps the current state", () => {
    const s = session("[00:00] message: text=one");
    const r = s.loadScript("BAD", "[sweatbox]\nairport = IRFD\n[00:00] airborne: callsign=X\n[00:00] message: text=fine");
    expect(r).toEqual({
      ok: false,
      errors: ["Line 3: airborne needs type, position, altitude, speed, level, route, from, to (callsign=… type=… position=… altitude=… speed=… level=… route=… from=… to=…)"],
    });
    // the old layout is refused with a pointer to the converter
    const old = s.loadScript("OLD", "0 SPAWN BAW1 A320 3000 300 250 HDG250 ITKO IRFD 1 2");
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.errors[0]).toMatch(/old-format sweatbox file.*pnpm sbx:convert/);
    expect(s.scriptName).toBe("TEST");
  });

  it("loading resets the clock, pauses and sets speed 1", () => {
    const s = session("[00:00] airborne: callsign=A1 type=A320 position=0,0 altitude=3000 speed=200 level=FL300 route=HDG090 from=IRFD to=ITKO");
    s.setSpeed(8);
    run(s, 10);
    s.loadScript("AGAIN", "[sweatbox]\nairport = IRFD\n[00:05] message: text=hi");
    expect(s.running).toBe(false);
    expect(s.speed).toBe(1);
    expect(s.elapsedSec).toBe(0);
    expect(s.aircraft).toEqual([]);
    expect(logs(s)).toEqual(['Loaded script "AGAIN" (2 commands)']); // the scope view, the message
  });

  it("sends the file's scope view and runways to each viewer once; late joiners don't get them again", () => {
    const s = session("[sweatbox]\nairport = IRFD\nview = GND\ndeparture runway = 25R\narrival runways = 25L, 25C\n[00:05] message: text=x");
    const early = { host: false, lastLogSeq: 0, lastCmdId: 0 };
    run(s, 1);
    expect(s.snapshotFor(early).cmds).toEqual([
      { id: 1, text: "LDARPT IRFD GND" },
      { id: 2, text: "RWYCFG IRFD 25R 25L,25C" },
    ]);
    expect(s.snapshotFor(early).cmds).toEqual([]);
    const late = { host: false, lastLogSeq: 0, lastCmdId: s.cmdSeq };
    run(s, 2);
    expect(s.snapshotFor(late).cmds).toEqual([]);
  });

  it("snapshots send log entries once and hide paths / clients from viewers", () => {
    const s = session("[00:00] message: text=hello");
    run(s, 1);
    const v = { host: false, lastLogSeq: 0, lastCmdId: 0 };
    expect(s.snapshotFor(v).log.map((l) => l.message)).toContain("hello");
    expect(s.snapshotFor(v).log).toEqual([]);
    expect(s.snapshotFor(v).clients).toBeUndefined();
    expect(s.snapshotFor({ host: true, lastLogSeq: 0, lastCmdId: 0 }).clients).toEqual([]);
  });

  it("records one replay frame per tick in the documented format", () => {
    const s = session("[00:00] airborne: callsign=R1 type=A320 position=1.23456789,2 altitude=3000 speed=200 level=FL300 route=HDG090 from=IRFD to=ITKO");
    run(s, 3);
    const st = s.end();
    expect(s.end()).toBe(st); // idempotent
    const r = s.replay();
    expect(r.format).toBe("atc24academy-sweatbox-replay");
    expect(r.version).toBe(1);
    expect(r.frameFields).toEqual(["callsign", "type", "x", "y", "altitude", "groundSpeed", "heading", "emergency"]);
    expect(r.frames.length).toBe(3);
    const f = r.frames[0]!;
    expect(f.t).toBe(1);
    expect(f.e).toBe(1);
    expect(f.a[0]![0]).toBe("R1");
    expect(String(f.a[0]![2]).split(".")[1]!.length).toBeLessThanOrEqual(4);
    expect(r.events.some((e) => e.message === "Session ended")).toBe(true);
    expect(() => s.play()).toThrow("Session has ended");
  });

  it("heading vectors are aviation angles", () => {
    expect(aviationAngle(fromAviationAngle(247))).toBeCloseTo(247);
  });
});
