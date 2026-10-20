import { beforeAll, describe, expect, it } from "vitest";
import {
  crossingStops,
  entryNearHold,
  holdShortNodes,
  holdsForRunway,
  pathPoints,
  pushFacingOptions,
  routeVia,
  shortestPath,
  standLeadIn,
  type GroundGraph,
} from "../src/ground";
import { registerTestAirport } from "../src/testing/itst";
import { groundMapsData, hasGroundMap } from "../src/world";
import { getGroundGraph } from "../src/ground";
import { buildGroundGraph } from "../src/ground";
import { isRoutable } from "../src/dataTypes";

let g: GroundGraph;
beforeAll(() => {
  g = registerTestAirport();
});

describe("graph", () => {
  it("computes lengths, adjacency and derived layers", () => {
    expect(g.edges[0]!.len).toBeCloseTo(0.5);
    expect(g.adj[13]!.length).toBe(3); // D, D, stand 1
    expect(g.taxiways.has("A")).toBe(true);
    expect(g.taxiways.has("1")).toBe(false); // stand edges are not taxiways
    expect(g.taxilines.length).toBe(22);
    expect(g.standlines.length).toBe(2);
    expect(g.edges.find((e) => e.name === "09/27")!.runway).toBe(true);
  });
});

describe("shortestPath", () => {
  it("avoids runways by default", () => {
    const p = shortestPath(g, 0, 4)!;
    expect(p.nodes).toEqual([0, 1, 2, 3, 4]);
    expect(p.length).toBeCloseTo(2);
  });
  it("may use runways when allowed", () => {
    const p = shortestPath(g, 6, 10, { avoidRunways: false })!;
    expect(p.nodes).toEqual([6, 8, 10]);
  });
  it("never drives through another stand", () => {
    const p = shortestPath(g, 15, 0)!; // from stand 1
    expect(p.nodes[0]).toBe(15);
    expect(p.nodes).not.toContain(16);
  });
  it("passes through intermediate nodes in order", () => {
    const p = shortestPath(g, 0, 4, {}, [11])!;
    expect(p.nodes).toContain(11);
  });
});

describe("routeVia", () => {
  it("follows the taxiways in order to a hold", () => {
    // from the stand 1 junction: D -> C -> A -> B1 hold
    const r = routeVia(g, 13, ["D", "C", "A", "B1"], 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.nodes).toEqual([13, 12, 11, 1, 0, 5]);
  });
  it("explains taxiways that don't connect", () => {
    const r = routeVia(g, 13, ["D", "B1"], 5);
    expect(r).toEqual({ ok: false, why: "D doesn't join B1, add the taxiway between them" });
  });
  it("explains unknown taxiways and unreachable starts", () => {
    expect(routeVia(g, 13, ["Q"], null)).toEqual({ ok: false, why: "Unknown taxiway Q" });
  });
  it("joins the first named taxiway from wherever the aircraft is", () => {
    // from the stand 1 junction on D, "via A, B1": D and C get it onto A
    const r = routeVia(g, 13, ["A", "B1"], 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.nodes).toEqual([13, 12, 11, 1, 0, 5]);
  });
  it("finishes onto the target's own taxiway when the clearance stops one short of it", () => {
    const r = routeVia(g, 13, ["D", "C", "A"], 5); // the B1 hold, "via D C A"
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.nodes[r.path.nodes.length - 1]).toBe(5);
  });
  it("goes to the end of the last taxiway without a target", () => {
    const r = routeVia(g, 13, ["D"], null);
    expect(r.ok).toBe(true);
    if (r.ok) expect([11, 14]).toContain(r.path.nodes[r.path.nodes.length - 1]);
  });
  it("respects picked points", () => {
    const r = routeVia(g, 13, ["D", "C", "A"], 4, { picked: [11] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.nodes).toEqual([13, 12, 11, 1, 2, 3, 4]);
  });
  it("forbids the U-turn after pushback", () => {
    const back = g.adj[13]!.find((id) => g.edges[id]!.name === "D" && (g.edges[id]!.a === 12 || g.edges[id]!.b === 12))!;
    const r = routeVia(g, 13, ["D", "C", "A"], 0, { forbidFirstEdge: back });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path.nodes.slice(0, 3)).toEqual([13, 14, 3]);
  });
});

describe("holds, entries, stands", () => {
  it("finds holds for a runway designator or pair", () => {
    expect(holdsForRunway(g, "27").map((h) => h.name)).toEqual(["B1 09/27", "B2 09/27", "B3 09/27", "X 09/27 S", "X 09/27 N"]);
    expect(holdsForRunway(g, "27/09").length).toBe(5);
  });
  it("a hold is valid only with an entry nearby", () => {
    expect(entryNearHold(g, g.holds[0]!)?.n).toBe(6);
  });
  it("hold short nodes", () => {
    expect(holdShortNodes(g, "A", "C").sort()).toEqual([1, 3]);
  });
  it("push facing options from a stand", () => {
    const opts = pushFacingOptions(g, g.standByName.get("1")!);
    expect(opts.map((o) => [o.hdg, o.twy]).sort()).toEqual([
      [270, "D"],
      [90, "D"],
    ]);
  });
  it("stand lead-in runs junction -> stand", () => {
    const line = standLeadIn(g, g.standByName.get("1")!);
    expect(line[0]).toEqual({ x: 1, y: 0.4 });
    expect(line[line.length - 1]).toEqual({ x: 1, y: 0.5 });
  });
  it("a path over a crossing edge stops at the hold bar before it, unless it starts there", () => {
    const across = routeVia(g, 3, ["X"], 21);
    expect(across.ok).toBe(true);
    if (!across.ok) return;
    expect(crossingStops(g, across.path)).toEqual([{ node: 17, rwy: "09/27" }]);
    const fromHold = routeVia(g, 17, ["X"], 21);
    expect(fromHold.ok && crossingStops(g, fromHold.path)).toEqual([]);
    const crossingEdge = g.edges.find((e) => e.crossing)!;
    expect(crossingEdge.runway).toBe(false); // a taxiway segment, routable by default
  });

  it("path points", () => {
    const p = shortestPath(g, 0, 2)!;
    expect(pathPoints(g, p)).toEqual([
      { x: 0, y: 0.2 },
      { x: 0.5, y: 0.2 },
      { x: 1, y: 0.2 },
    ]);
  });
});

describe("real ground maps", () => {
  it("every shipped ground map builds", () => {
    for (const [icao, data] of Object.entries(groundMapsData)) {
      if (icao === "ITST") continue;
      expect(hasGroundMap(icao), icao).toBe(isRoutable(data)); // drawn-only maps get no ground traffic
      if (!isRoutable(data)) continue;
      const graph = buildGroundGraph(data, icao);
      expect(graph.nodes.length).toBeGreaterThan(0);
      for (const s of graph.stands) {
        const opts = pushFacingOptions(graph, s);
        expect(opts.length, `${icao} stand ${s.name}`).toBeGreaterThan(0);
        // a controller can pick each one by its heading
        expect(new Set(opts.map((o) => o.hdg)).size, `${icao} stand ${s.name} push headings`).toBe(opts.length);
      }
      // no taxiway of zero length (two nodes on one spot)
      for (const e of graph.edges) expect(e.len, `${icao} edge ${e.id} (${e.name})`).toBeGreaterThan(1e-4);
    }
  });
});

describe("IRFD ground map", () => {
  const g = getGroundGraph("IRFD")!;
  const pairs = ["07L/25R", "07C/25C", "07R/25L"];

  it("has the 20 stands and the chart's 25 holds", () => {
    expect(g.stands.map((s) => s.name).sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    expect(g.holds.length).toBe(25);
    expect(g.holds.map((h) => h.name)).toEqual(expect.arrayContaining(["A1 07R/25L", "E 07R/25L N", "E 07R/25L S", "H 07C/25C", "B1 07L/25R", "M2 07C/25C"]));
  });

  it("every stand pushes back and reaches a departure hold for every runway", () => {
    for (const s of g.stands) {
      expect(pushFacingOptions(g, s).length, `stand ${s.name}`).toBeGreaterThan(0);
      for (const pair of pairs) {
        const holds = holdsForRunway(g, pair).filter((h) => entryNearHold(g, h));
        expect(holds.some((h) => shortestPath(g, s.j, h.n)), `stand ${s.name} -> ${pair}`).toBe(true);
      }
    }
  });

  it("every runway entry leads to every stand, except the M turnaround loop at the 25C end", () => {
    for (const e of g.entries) {
      const loop = ["M", "M1", "M2"].includes(e.twy);
      for (const s of g.stands) expect(shortestPath(g, e.n, s.j) !== null, `${e.rwy} ${e.twy} -> ${s.name}`).toBe(!loop);
    }
  });

  it("A then A5 reaches the A5 hold from every stand (joining A on the way)", () => {
    const a5 = g.holds.find((h) => h.name === "A5 07R/25L")!.n;
    for (const st of g.stands) {
      const r = routeVia(g, st.j, ["A", "A5"], a5);
      expect(r.ok, `stand ${st.name}: ${r.ok ? "" : r.why}`).toBe(true);
    }
  });

  it("every hold is reachable from every stand by naming just the hold's taxiway", () => {
    const loop = ["M", "M1", "M2"]; // the turnaround loop at the 25C end only joins the runway
    for (const st of g.stands)
      for (const h of g.holds.filter((x) => !loop.includes(x.twy))) {
        const r = routeVia(g, st.j, [h.twy], h.n);
        expect(r.ok, `stand ${st.name} -> ${h.name}: ${r.ok ? "" : r.why}`).toBe(true);
      }
  });

  it("explains a taxiway that can't be reached", () => {
    const m = g.holds.find((h) => h.name === "M1 07C/25C")!.n; // the M loop only joins the runway
    expect(routeVia(g, m, ["A"], null)).toEqual({ ok: false, why: "Can't reach A from here" });
  });

  it("routes by taxiway names, crossing runways where the route says so", () => {
    const five = g.standByName.get("5")!;
    const toA1 = routeVia(g, five.j, ["A", "A1"], g.holds.find((h) => h.name === "A1 07R/25L")!.n);
    expect(toA1.ok).toBe(true);
    const crossE = routeVia(g, five.j, ["A", "E", "E2"], g.holds.find((h) => h.name === "E2 07L/25R")!.n);
    expect(crossE.ok, crossE.ok ? "" : crossE.why).toBe(true);
    if (crossE.ok) expect(crossingStops(g, crossE.path).map((s) => s.rwy)).toEqual(["07R/25L"]);
  });
});
