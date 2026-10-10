# Adding an airport ground map

A ground map gives an airport surface movement (pushback, taxi, line-up, rollout to a stand) and
the detailed GND / TWR drawing. It is one JSON file, `data/ground/<icao>.json`, rebuilt into the
app by `pnpm data`. Airports without one still show their runways, plus the drawing-only artwork
from `data/ground-art/` when there is some (which may carry hold bars and labels too). While the
routing graph is being built, a file with only the drawing layers (no `ground`) is drawn, but DEL /
GND sweatboxes aren't offered there. The other way round, a file with only `ground` (no
`pavement`) gives the airport ground traffic and keeps its `ground-art` drawing; IRFD works that
way, with its graph traced along the artwork's yellow centrelines.

The working example is the synthetic test airport in
[`packages/shared/src/testing/itst.ts`](../packages/shared/src/testing/itst.ts), which the unit
tests drive through every ground manoeuvre. Copy its shape.

## 1. Trace the chart

Get the airport's ground chart (the in-game layout, or the community charts) and trace it in a
vector editor such as Inkscape:

- **pavement**: taxiways and aprons as filled polygons
- **buildings**: terminals and hangars as filled polygons
- **land** (optional): the grass area around the field
- **taxiway centrelines**: one polyline per taxiway segment, joined at intersections
- **hold bars**: a short polyline across the taxiway at each runway holding point
- **stand lead-in lines**: from the taxiway centreline to each parking position
- **labels**: taxiway designators, stand numbers and named areas such as "Fuel"

## 2. Georeference on the runway ends

Everything must be in PTFS **map units** (x east, y south, 1 NM = 3.30714286 units). The runway
ends in `data/runways.txt` are your control points:

1. Place the two thresholds of one runway in your drawing.
2. Work out the scale (map units per drawing unit) from the distance between them, and the
   rotation and offset that carry your drawing onto the `runways.txt` coordinates.
3. Apply that transform to every point. Check it against a second runway: the thresholds should
   land within a few hundredths of a unit.

Keep 4 to 5 decimals. A taxiway is roughly 0.03 units wide and an A320 about 0.07 units long.

## 3. Build the routing graph

The routing graph lives under `"ground"`:

Runways are referred to by their pair string exactly as `runways.txt` stores it, `name1/name2`
(`07L/25R`; IPPH is `29/11`, not `11/29`). The reversed order is accepted too.

| Key | Meaning |
|---|---|
| `nodes` | `[[x, y], ...]`. Put a node at every intersection, every hold, every runway entry, every stand and every stand's junction with the taxiway. |
| `edges` | `[{ "a": 0, "b": 1, "name": "A", "pts": [[x, y], ...] }]`, one per centreline segment between two nodes. `pts` is the polyline from node `a` to node `b`. The endpoints are optional; if they're missing they are added. `name` is the taxiway (`A`, `A1`, `K2`); `APRON` is an apron taxilane without a published name. Runway segments are named like the runway pair (`07C/25C`) so AUTO routing avoids them. |
| `edges[].crossing` | `"crossing": "07R/25L"` on the part of a taxiway that lies on a runway, from the entry on one edge to the entry on the other. An aircraft on it is on the runway. A route that uses it stops at that runway's hold bar first, showing `HOLD SHORT <rwy>`, until the trainer presses CONT. |
| `edges[].stand` | Stand lead-ins: `{ "a": <stand node>, "b": <junction>, "name": "", "stand": "5", ... }`, so `a` is the stand's `n` and `b` its `j` (`pnpm data` warns otherwise). Routes never pass through another stand. |
| `holds` | `[{ "n": 5, "twy": "B1", "rwy": "09/27", "name": "B1 09/27" }]`: runway holding points, with the node on the red bar. The name is `<twy> <rwy>`, plus ` N` / ` S` when the same taxiway has a hold on each side of the runway. A hold with no entry on its runway within `ground.autoHoldEntryMaxUnits` (0.3) is crossing-only: AUTO and the TKOF runway list never use it. |
| `entries` | `[{ "n": 6, "rwy": "09/27", "twy": "B1" }]`: the node on the runway **edge** where each taxiway meets it. Line-up goes from there onto the centreline, facing the runway heading. |
| `stands` | `[{ "name": "5", "n": 15, "j": 13, "hdg": 180, "line": [[x, y], ...] }]`: the stand node, the junction node on the taxiway, the nose-in heading and the lead-in line (its first point near the stop position). Pushback offers one facing per taxiway edge at the junction; where the junction is the end of a taxiway, the tail goes into the end and the nose faces out along it. |

`len` and adjacency are computed when the map loads, so you don't write them.
`taxilines` (every non-stand edge's `pts`) and `standlines` (every stand `line`) are derived too.

## 4. The drawing layers

At the top level, next to `"ground"`:

```json
{
  "source": "Traced from the 2025 chart",
  "rwyHalfWidth": 0.03,
  "land": [[[x, y], ...]],
  "pavement": [[[x, y], ...]],
  "buildings": [[[x, y], ...]],
  "holds": [[[x, y], [x, y]]],
  "labels": [{ "t": "A1", "k": "twy", "p": [x, y] }, { "t": "5", "k": "stand", "p": [x, y] }],
  "ground": { "nodes": [], "edges": [], "holds": [], "entries": [], "stands": [] }
}
```

`labels[].k` is `twy`, `stand`, `rwy` or `area` (for example "Fuel"). `rwyHalfWidth` is the drawn
runway rectangle's half-width in map units. `holds` here are the red bars as drawn, separate from
`ground.holds`.

The GND view draws, bottom to top: land, pavement (even-odd fill), buildings, runways with their
numbers, taxiway centrelines (yellow), stand lead-in lines (grey), hold bars (red) and the labels
(from 60 px per unit, never under a tag). The TWR view dims pavement, buildings and centrelines
and hides the stand lines and labels. Colours and widths are `colours.ground` and `ui.ground` in
`sweatbox.config.ts`.

## 5. Check it

```sh
pnpm data                # validates the file: node references, runway names, stand lead-ins
pnpm --filter @sweatbox/shared test   # every shipped ground map must build and every stand must offer a pushback
pnpm dev                 # then LDARPT <ICAO> GND on the scope
```

On the scope, select a parked aircraft (spawn one with a `parked:` line) and try PUSH, TAXI with
"Pick points on map" (it highlights every node), TKOF and arrivals with `after landing = stand`. If an
instruction is refused, its message names the problem, for example `A doesn't join K, add the
taxiway between them`. That usually means a missing node at an intersection.
