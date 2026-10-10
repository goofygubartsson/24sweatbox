// Synthetic test airport "ITST" with a small ground map, used by unit tests on both sides so that
// ground logic can be tested without depending on the real (and changing) airport data. It follows
// the same conventions as the real maps: entries on the runway edge, holds named "<twy> <rwy>",
// stand lead-ins from the stand (a) to its junction (b), and a crossing segment on the runway.
//
//                             X N(21)
//                             |
//                             H(20)  X 09/27 N
//        E1(6)=====E2(8)======E3(10) ...... runway 09/27 along y = 0 (entries on its south edge,
//         |H1(5)   |H2(7)   X(19,18) |H3(9)    X crosses it at x = 1.5)
//        A0(0)--A1(1)--A2(2)--A3(3)--A4(4)       taxiway A
//                 |C          |C  \_ X 09/27 S hold (17) between A3 and the runway
//                C1(11)-D0(12)-D1(13)-C2(14)     taxiway D
//                        |2     |1
//                       S2(16) S1(15)            stands (nose-in, hdg 180)
import type { RoutableGroundMap } from "../dataTypes";
import { buildGroundGraph, registerGroundGraph, type GroundGraph } from "../ground";
import { registerRunwayPair } from "../runways";
import { registerAirport, registerGroundMapData } from "../world";

export const ITST_GROUND: RoutableGroundMap = {
  icao: "ITST",
  source: "synthetic test airport",
  rwyHalfWidth: 0.03,
  land: [],
  pavement: [],
  buildings: [],
  holds: [],
  labels: [],
  ground: {
    nodes: [
      [0, 0.2],
      [0.5, 0.2],
      [1, 0.2],
      [1.5, 0.2],
      [2, 0.2],
      [0, 0.1],
      [0, 0.03],
      [1, 0.1],
      [1, 0.03],
      [2, 0.1],
      [2, 0.03],
      [0.5, 0.4],
      [0.7, 0.4],
      [1, 0.4],
      [1.5, 0.4],
      [1, 0.5],
      [0.7, 0.5],
      [1.5, 0.1],
      [1.5, 0.03],
      [1.5, -0.03],
      [1.5, -0.1],
      [1.5, -0.2],
    ],
    edges: [
      { a: 0, b: 1, name: "A", pts: [[0, 0.2], [0.5, 0.2]] },
      { a: 1, b: 2, name: "A", pts: [[0.5, 0.2], [1, 0.2]] },
      { a: 2, b: 3, name: "A", pts: [[1, 0.2], [1.5, 0.2]] },
      { a: 3, b: 4, name: "A", pts: [[1.5, 0.2], [2, 0.2]] },
      { a: 0, b: 5, name: "B1", pts: [[0, 0.2], [0, 0.1]] },
      { a: 5, b: 6, name: "B1", pts: [[0, 0.1], [0, 0.03]] },
      { a: 2, b: 7, name: "B2", pts: [[1, 0.2], [1, 0.1]] },
      { a: 7, b: 8, name: "B2", pts: [[1, 0.1], [1, 0.03]] },
      { a: 4, b: 9, name: "B3", pts: [[2, 0.2], [2, 0.1]] },
      { a: 9, b: 10, name: "B3", pts: [[2, 0.1], [2, 0.03]] },
      { a: 6, b: 8, name: "09/27", pts: [[0, 0.03], [1, 0.03]] },
      { a: 8, b: 10, name: "09/27", pts: [[1, 0.03], [2, 0.03]] },
      { a: 1, b: 11, name: "C", pts: [[0.5, 0.2], [0.5, 0.4]] },
      { a: 3, b: 14, name: "C", pts: [[1.5, 0.2], [1.5, 0.4]] },
      { a: 11, b: 12, name: "D", pts: [[0.5, 0.4], [0.7, 0.4]] },
      { a: 12, b: 13, name: "D", pts: [[0.7, 0.4], [1, 0.4]] },
      { a: 13, b: 14, name: "D", pts: [[1, 0.4], [1.5, 0.4]] },
      { a: 15, b: 13, name: "", pts: [[1, 0.5], [1, 0.4]], stand: "1" },
      { a: 16, b: 12, name: "", pts: [[0.7, 0.5], [0.7, 0.4]], stand: "2" },
      { a: 3, b: 17, name: "X", pts: [[1.5, 0.2], [1.5, 0.1]] },
      { a: 17, b: 18, name: "X", pts: [[1.5, 0.1], [1.5, 0.03]] },
      { a: 18, b: 19, name: "X", pts: [[1.5, 0.03], [1.5, -0.03]], crossing: "09/27" },
      { a: 19, b: 20, name: "X", pts: [[1.5, -0.03], [1.5, -0.1]] },
      { a: 20, b: 21, name: "X", pts: [[1.5, -0.1], [1.5, -0.2]] },
    ],
    holds: [
      { n: 5, twy: "B1", rwy: "09/27", name: "B1 09/27" },
      { n: 7, twy: "B2", rwy: "09/27", name: "B2 09/27" },
      { n: 9, twy: "B3", rwy: "09/27", name: "B3 09/27" },
      { n: 17, twy: "X", rwy: "09/27", name: "X 09/27 S" },
      { n: 20, twy: "X", rwy: "09/27", name: "X 09/27 N" },
    ],
    entries: [
      { n: 6, rwy: "09/27", twy: "B1" },
      { n: 8, rwy: "09/27", twy: "B2" },
      { n: 10, rwy: "09/27", twy: "B3" },
      { n: 18, rwy: "09/27", twy: "X" },
      { n: 19, rwy: "09/27", twy: "X" },
    ],
    stands: [
      { name: "1", n: 15, j: 13, hdg: 180, line: [[1, 0.5], [1, 0.4]] },
      { name: "2", n: 16, j: 12, hdg: 180, line: [[0.7, 0.5], [0.7, 0.4]] },
    ],
  },
};

let registered: GroundGraph | null = null;

/** Register ITST (airport, runway 09/27, ground map) in the shared world. Idempotent. */
export function registerTestAirport(): GroundGraph {
  if (registered) return registered;
  registerAirport({ code: "ITST", name: "Test Field", iata: "", freqs: {}, topDowns: [], centre: [1, 0], runways: ["09/27"], depRunways: [] });
  registerRunwayPair({ icao: "ITST", name1: "ITST-09", name2: "ITST-27", position1: { x: 0, y: 0 }, position2: { x: 2, y: 0 }, pair: "09/27" });
  registerGroundMapData("ITST", ITST_GROUND);
  registered = buildGroundGraph(ITST_GROUND, "ITST");
  registerGroundGraph(registered);
  return registered;
}
