# Sweatbox data

Hand-maintained reference data. `pnpm data` (`scripts/build-data.ts`) parses and validates these
files with zod and writes typed JSON to `packages/shared/src/data/`, which the server and the web
app both import. Points are `[x, y]` in PTFS map units (x east, y south, 1 NM = 3.30714286 units).

## Where the current data comes from

The spec's Appendix D (the authoritative data) was cut off, so this folder holds what could be
recovered plus placeholders. See `spec/README.md`.

| File | Status |
|---|---|
| `airports.json` | The 23 airports and names from the spec. Satellites (`topDowns`) are from the old 24RC island map. **IATA codes and frequencies are empty.** |
| `runways.txt` | 25 runway pairs at 20 airports. IRFD and IPPH use the exact thresholds from the ground-map spec; the others are **derived** from the 24RC runway centreline SVGs, named from the computed true heading. IKFL, IBAR and ITEY have no runways yet. Replace with Appendix D.3. |
| `fixes.txt` | `[main]`: the 145 fixes and navaids of the ATC24 sweatbox build (its `fixes.json`, read off the scope there); generated departures route over them. `[extra]`: 4 estimated SID fixes. The spec's aeronav table (Appendix D.2) is still missing. |
| `map-outlines.txt`, `map-airspace.txt` | Coastlines and airspace lines **derived** from the 24RC SVGs (px / 10). |
| `sectors.json` | Empty: FIR polygons were not available. The scope draws `map-airspace.txt` instead. |
| `sids.json` | Empty (Appendix D.6). Routes with SID tokens fall back to their fixes. |
| `aircraft.txt` | Type map from 24RC; wake categories and lengths from ICAO data. |
| `callsigns.txt` | Spoof airlines from 24RC; real radio callsigns for the common airlines. |
| `ground/*.json` | `irfd.json`: IRFD's taxi graph, traced from the yellow centrelines of its ground artwork (below), with the holds, stand positions and taxiway names from the IRFD ground chart. It has no drawing layers of its own, so IRFD keeps the old artwork. The pasted spec was cut off before IPPH, which has no ground map yet. |
| `ground-art/*.json` | Ground drawings (pavement, taxi lines, buildings) for 20 airports from 24RC, used where there is no `ground/` file. IRFD's is shifted by (+0.0408, +0.0344) onto its exact runway thresholds and carries the IRFD chart's runway width, hold bars, taxiway names and stand numbers. IPPH's sits slightly off its exact thresholds. |
| `scenarios/*.sbx` | Three development samples (`*-DEMO.sbx`) and `CTR-IRFD-SHOWCASE.sbx` (CTR, TWR and GND traffic at once, every flight on a fix route). The 18 legacy scenarios (Appendix D.10) are missing. |

## Formats

### `airports.json`
```json
[{ "code": "IRFD", "name": "Rockford", "iata": "", "freqs": { "TWR": "118.100" }, "topDowns": ["IMLR"] }]
```
Optional: `"centre": [x, y]` (default: the average of the airport's runway ends),
`"runways": ["07L/25R"]` (default: from `runways.txt`) and `"depRunways": ["07R", "25L"]`, the main
departure runway for each direction (generated sweatboxes send departures there and land on the
others; default: the right-hand runway).

### `runways.txt`
One pair per line, `name1 name2 x1 y1 x2 y2`, where `position1` is the threshold of `name1`:
```
IRFD-07R IRFD-25L -4.0201 20.9764 -1.9892 20.1113
```
The pair string other data uses is `name1/name2` in this order (`07R/25L`, IPPH `29/11`).

### `fixes.txt`
`NAME TYPE X Y` under `[main]` (drawn on the scope), `[aeronav]` (not drawn) and `[extra]`
(estimated SID fixes). All of them are valid for routes, DCT and holds. If a name is defined
twice, the first definition wins (the legacy app had two overlapping tables).

### `map-outlines.txt`, `map-airspace.txt`
One SVG path `d` string per line, already in map units.

### `sectors.json`
`{ "CODE": { "name": "Rockford FIR", "polygon": [[x, y], ...] } }`

### `sids.json`
`{ "APT": { "TOKEN": { "RWY": ["FIX", ...], "ALL": [...] } } }`. TOKEN is `SID` or
`SID.TRANSITION`. An empty list means fly straight out 8 NM, then the transition fix, then direct.

### `aircraft.txt`
`[types]` lines are `Roblox name = ICAO` (case-insensitive; a trailing ` Cargo` is stripped).
`[info]` lines are `ICAO WAKE LENGTH_M`, with WAKE one of L/M/H/J.

### `callsigns.txt`
`[spoof]` lines are `Spoken name = ICAO airline`; `[radio]` lines are `ICAO = RADIO CALLSIGN`.

### `ground/<icao>.json`
Drawing layers plus the routing graph (`ground`); see `docs/adding-an-airport.md`. A file without
`ground` is drawn, but DEL / GND sweatboxes aren't offered there (`pnpm data` warns about it). A
file without drawing layers (no `pavement`) routes traffic while the airport keeps its
`ground-art` drawing.

### `ground-art/<icao>.json`
`{ "source": "...", "pavement": [d...], "taxilines": [d...], "buildings": [{ "d": "...", "fill": "#rrggbb" }] }`
(SVG path strings in map units; drawing only). Optional, as on a ground map: `rwyHalfWidth`,
`holds` (hold-bar polylines) and `labels` (`[{ "t": "A1", "k": "twy", "p": [x, y] }]`).

### `scenarios/*.sbx`
A `[sweatbox]` section (airport, view, runways, after landing) followed by one
`[mm:ss] event: key=value …` line per event. See `docs/user-guide.md` or
`packages/shared/src/script.ts`. Old-layout files (`0 SPAWN …`) convert with `pnpm sbx:convert`.
Names follow `[POS]-[APT]-[RWY].sbx`, for example `TWR-IRFD-25.sbx`.
