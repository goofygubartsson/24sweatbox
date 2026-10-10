import { beforeAll, describe, expect, it } from "vitest";
import { parseScript } from "../src/script";
import {
  GeneratorError,
  POSITIONS,
  generateSweatbox,
  generatorAirports,
  makeItem,
  planSweatbox,
  runwayFormats,
  sweatboxScript,
  type Position,
} from "../src/generator";
import { registerTestAirport } from "../src/testing/itst";
import { fixRouteBetween } from "../src/routes";
import { airportRef, getFix } from "../src/world";
import { getGroundGraph } from "../src/ground";

beforeAll(() => {
  registerTestAirport();
});

describe("runway formats", () => {
  it("groups runway ends by number: depart the main departure runway, land on the others", () => {
    // IRFD's main departure runways (airports.json depRunways) are 07R / 25L
    expect(runwayFormats("IRFD")).toEqual([
      { id: "07", label: "07L / 07C / 07R", dep: "07R", arr: ["07L", "07C"] },
      { id: "25", label: "25L / 25C / 25R", dep: "25L", arr: ["25C", "25R"] },
    ]);
    expect(runwayFormats("IPAP")).toEqual([
      { id: "17", label: "17", dep: "17", arr: ["17"] },
      { id: "35", label: "35", dep: "35", arr: ["35"] },
    ]);
  });
});

describe("generated sweatboxes", () => {
  it("every airport, position and runway format either generates a valid script or says why not", () => {
    for (const a of [...generatorAirports().map((x) => x.code)]) {
      for (const f of runwayFormats(a)) {
        for (const position of POSITIONS) {
          try {
            const g = generateSweatbox({ apt: a, position, runway: f.id, durationMin: 10 });
            const r = parseScript(g.text);
            expect(r.errors, `${position}-${a}-${f.id}`).toEqual([]);
            expect(g.name).toBe(`${position}-${a}-${f.id}`);
            expect(g.aircraft).toBeGreaterThan(0);
          } catch (e) {
            expect(e).toBeInstanceOf(GeneratorError);
            expect((e as GeneratorError).kind).toBe("unavailable");
            expect(["DEL", "GND"]).toContain(position);
          }
        }
      }
    }
  });

  it("uses the airport, position and runway format it was given", () => {
    const g = generateSweatbox({ apt: "IRFD", position: "TWR", runway: "25" });
    expect(g.text).toContain(
      "[sweatbox]\nname = TWR-IRFD-25\nairport = IRFD\nview = TWR\ndeparture runway = 25L\narrival runways = 25C, 25R\nafter landing = stand\n",
    );
    expect(g.text).not.toMatch(/^\d+ [A-Z]+ /m); // none of the old "0 SPAWN …" lines
    expect(g.text).toMatch(/^\[\d\d:\d\d\] approach: callsign=\S+ runway=25[CR]$/m);
    expect(g.text).not.toMatch(/=07/);
    const app = generateSweatbox({ apt: "IPPH", position: "APP", runway: "29" });
    expect(app.text).toContain("airport = IPPH\nview = CTR\n");
    expect(app.text).toMatch(/\] departing: callsign=\S+ type=\S+ runway=29 /);
  });

  it("scales traffic with the level", () => {
    const light = planSweatbox({ apt: "IRFD", position: "APP", runway: "25", level: "light", durationMin: 60 }).items.length;
    const heavy = planSweatbox({ apt: "IRFD", position: "APP", runway: "25", level: "heavy", durationMin: 60 }).items.length;
    expect(heavy).toBeGreaterThan(light);
  });

  it("explains bad settings", () => {
    expect(() => generateSweatbox({ apt: "IXXX", position: "TWR", runway: "25" })).toThrow("Unknown airport IXXX");
    expect(() => generateSweatbox({ apt: "IRFD", position: "TWR", runway: "18" })).toThrow("IRFD has no runway 18");
    expect(() => generateSweatbox({ apt: "IPPH", position: "GND", runway: "29" })).toThrow("IPPH has no ground map yet, so GND sweatboxes aren't available there");
  });

  it("GND and DEL park aircraft on free stands and wait for instructions; TWR taxis them out", () => {
    const gnd = planSweatbox({ apt: "ITST", position: "GND", runway: "27", durationMin: 10 });
    expect(gnd.rollout).toBe("HOLD");
    const parked = gnd.items.filter((i) => i.kind === "dep-stand");
    expect(parked.every((i) => i.autoDelay === null && !i.autoClr)).toBe(true);
    // every stand starts occupied (ITST has 2); later departures take the next stand that frees up
    expect(parked.filter((i) => i.time === 0 && i.stand !== "*").map((i) => i.stand).sort()).toEqual(["1", "2"]);
    expect(parked.filter((i) => i.stand === "*").length).toBeGreaterThan(10);
    const gndScript = sweatboxScript(gnd).text;
    expect(gndScript).not.toContain("autodep:");
    expect(gndScript).toMatch(/\] parked: callsign=\S+ type=\S+ stand=any /);
    expect(parseScript(gndScript).errors).toEqual([]);

    // DEL: they wait for the clearance, then go by themselves
    const del = sweatboxScript(planSweatbox({ apt: "ITST", position: "DEL", runway: "27", durationMin: 10 })).text;
    expect(del).toMatch(/^\[00:00\] autodep: callsign=\S+ runway=27 when=cleared$/m);
    expect(parseScript(del).errors).toEqual([]);

    const twr = planSweatbox({ apt: "ITST", position: "TWR", runway: "27", durationMin: 10 });
    expect(twr.rollout).toBe("STAND");
    expect(sweatboxScript(twr).text).toMatch(/\] autodep: callsign=\S+ runway=27$/m);
  });

  it("makeItem gives a new aircraft or null when it can't fit", () => {
    const format = runwayFormats("IRFD")[1]!;
    const it = makeItem({ apt: "IRFD", position: "APP" as Position, format, items: [] }, "inbound", 120);
    expect(it?.kind).toBe("inbound");
    expect(Math.abs(it!.x)).toBeLessThanOrEqual(58);
    const ipph = runwayFormats("IPPH")[0]!;
    expect(makeItem({ apt: "IPPH", position: "TWR", format: ipph, items: [] }, "dep-stand", 0)).toBeNull(); // no ground map
    expect(makeItem({ apt: "IRFD", position: "TWR", format, items: [] }, "dep-stand", 0)?.stand).toBeTruthy();
  });

  it("TWR: every stand occupied, pushing to the departure runway one after another, nothing spawned on a runway", () => {
    const stands = getGroundGraph("IRFD")?.stands.length ?? 0;
    const plan = planSweatbox({ apt: "IRFD", position: "TWR", runway: "25", level: "normal", durationMin: 30 });
    const parked = plan.items.filter((i) => (i.kind === "dep-stand" || i.kind === "cct-ga") && i.time === 0);
    expect(parked.length).toBe(stands);
    expect(new Set(parked.map((i) => i.stand)).size).toBe(stands);
    expect(plan.items.some((i) => i.kind === "dep-air" || (i.kind === "dep-stand" && i.time > 0))).toBe(false);
    // the GA circuit flights use the departure runway, on the side away from the other runways
    const ga = parked.filter((i) => i.kind === "cct-ga");
    expect(ga.length).toBe(2);
    expect(ga.every((i) => i.runway === "25L" && i.side === "L")).toBe(true);
    // pushes from 00:20, one every 60 / (perMinute x rate) s; the rest stay parked
    const every = Math.round(60 / (0.6 * 1));
    const pushes = parked.map((i) => i.autoDelay).filter((d): d is number => d !== null).sort((a, b) => a - b);
    expect(pushes[0]).toBe(20);
    expect(pushes.every((d, k) => d === 20 + k * every)).toBe(true);
    const text = sweatboxScript(plan).text;
    expect(text).not.toContain("departing:");
    expect(text).toMatch(/^\[00:20\] autodep: callsign=\S+ runway=25L$/m);
    expect(parseScript(text).errors).toEqual([]);
    // no ground map: arrivals only, still nothing on a runway
    expect(sweatboxScript(planSweatbox({ apt: "IPPH", position: "TWR", runway: "29", durationMin: 20 })).text).not.toMatch(/departing:|parked:/);
  });

  it("departures fly published fixes toward their destination, climbing to 3000 ft", () => {
    const plan = planSweatbox({ apt: "IRFD", position: "GND", runway: "25", durationMin: 10 });
    const deps = plan.items.filter((i) => i.kind === "dep-stand");
    expect(deps.length).toBeGreaterThan(0);
    for (const d of deps) {
      expect(d.climb).toBe(3000);
      expect(d.route).toBe(fixRouteBetween("IRFD", d.arr));
      for (const name of d.route.split(",")) expect(getFix(name), name).toBeDefined();
    }
    // in order from IRFD toward IPPH, off the airport
    const route = fixRouteBetween("IRFD", "IPPH")!.split(",").map((n) => getFix(n)!.pos);
    const from = airportRef("IRFD")!;
    const to = airportRef("IPPH")!;
    const along = route.map((p) => (p.x - from.x) * (to.x - from.x) + (p.y - from.y) * (to.y - from.y));
    expect(along).toEqual([...along].sort((a, b) => a - b));
    expect(along[0]).toBeGreaterThan(0);
  });

  it("IRFD GND sweatboxes park departures on IRFD stands", () => {
    const sb = generateSweatbox({ apt: "IRFD", position: "GND", runway: "25" });
    expect(sb.name).toBe("GND-IRFD-25");
    expect(sb.text).toMatch(/^\[00:00\] parked: callsign=\S+ type=\S+ stand=\d+ /m);
    const r = parseScript(sb.text);
    expect(r.errors).toEqual([]);
  });
});
