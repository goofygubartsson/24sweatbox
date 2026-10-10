# Using ATC24Academy Sweatbox

## Trainers

1. Log in with Discord. Trainers are recognised by their Discord role.
2. Under **Create Sweatbox**, pick the **Airport**, the **Position** being trained and the
   **Runway format** (the runway direction in use), then press **Create Sweatbox**. The sweatbox
   file is generated from these three choices and loaded straight away; there is nothing to build
   or edit.
3. Share the 6-letter session code (click it in the top bar to copy it). Trainees join with it.
4. Press **Play**. **Session** (top right) holds the speed, the TWR landing-clearance switch, who is
   connected, **Load sweatbox** (the same three choices, for the next exercise) and **End session**.
5. When the session ends, everyone gets a short summary and the replay.

DEL and GND sweatboxes need the airport's ground map (stands and taxiways); airports without one
only offer TWR, APP and CTR. Both start with an aircraft on every stand, and a stand that frees up
gets the next departure a little later, so the apron stays busy. GND also has a steady stream of
arrivals that vacate the runway and wait for taxi instructions.

A TWR sweatbox also starts with an aircraft on every stand (two of them GA circuit flights). They
push back and taxi to a holding point of the departure runway by themselves, one after another,
and wait there for a takeoff clearance; nothing ever appears on a runway. Arrivals come in on
final for the arrival runways, need a landing clearance and then taxi to a free stand (crossing
runways when cleared to). At an airport without a ground map, TWR has the arrivals only.

At Rockford the departure runway is 25L (07R the other way round); 25C and 25R (07L, 07C) take the
arrivals.

### Departures

- **One takeoff at a time:** at an airport, an aircraft cleared for takeoff doesn't start rolling
  while another is rolling, or until the one before it is airborne and through 100 ft. Its status
  shows `CLEARED FOR TAKEOFF 25L, WAITING FOR <callsign>`.
- **Busy runways:** automatic departures (DEL, TWR) taxi to the departure runway. When five are
  already queued for it, the next one goes to the next runway of the sweatbox's runway settings
  (at Rockford 25C, then 25R).
- **After takeoff** a departure climbs to its initial climb (3000 ft unless the strip's CLMB says
  otherwise). It then flies its route, a list of real fixes toward its destination. A route that
  starts behind the aircraft is joined only at the initial climb, so it doesn't turn back low over
  the airport. At the end of the route it joins a final at the destination and lands there, and
  then it is removed (`ARRIVED <callsign> <airport>` in the log).
- **TWR mode** (landing clearances) is the session airport's tower: aircraft landing at other
  airports don't need a clearance.
- **Separation:** until a controller instructs it, a departure flying on its own keeps the
  separation minimum, 1 NM or 1000 ft, from all other traffic. It looks about 90 s ahead and
  levels off below conflicting traffic, climbs above it, or slows down behind traffic ahead on
  its track. If the final ahead is busy, it holds beside the start of the final until that final
  is clear.
  Fully automatic (DEL) departures also wait at the holding point until their climb-out is clear.
  Circuit traffic is left to the tower (it is separated visually).
- Separation losses (closer than 1 NM and 1000 ft) are reported in the log, except between
  approaches to parallel runways and between a departure and an aircraft landing on a parallel
  runway.

### DEL: clearances

In a DEL sweatbox the departures wait on their stands until they are cleared. Click the **C**
cell of a departure in the Departures list to give the clearance. From then on the aircraft runs
its own departure: 20 seconds after the clearance it pushes back, as soon as that is safe (nobody
behind it, its route clear of opposing or stopped traffic). It then taxis to a holding point for
the departure runway, crosses runways when they are free, lines up and takes off. The C cell shows a tick; hover over it to see where
the departure is: **CLR** (cleared, on stand), **PUSH**, **TAXI**, **HOLD**, **LU** (lining up),
**DEP** (rolling) and **AIR**. Click the tick again to take the clearance back while the aircraft
is still on its stand.

### Showcase

`data/scenarios/CTR-IRFD-SHOWCASE.sbx` puts CTR, TWR and GND traffic around Rockford in one
45-minute file. Load it from the scope with `SBLOAD CTR-IRFD-SHOWCASE`.

- **GND:** departures parked at Rockford waiting for a push.
- **DEL:** departures waiting for their clearance.
- **TWR:** departures that taxi out by themselves and wait at the 25L holding point, plus arrivals
  landing on 25C and 25R that then cross 25L to a stand.
- **Fully automatic departures:** they push, taxi and depart by themselves.
- **CTR:** through traffic between other airports.
- **Mellor:** two light aircraft in the circuit.

Every flight except the circuit traffic flies a route of real fixes. Everyone starts on the radar
view: `LDARPT IRFD TWR` or `LDARPT IRFD GND` switches your own scope, and **Session > TWR** makes
Rockford arrivals need a landing clearance.

The **Maker** (bottom of the start page, trainers only) is for adjusting the traffic by hand:
generate it the same way, change, add or remove individual aircraft, then download the `.sbx`
file or load it into a session.

## On the scope

- Drag to pan, scroll to zoom. Double-click empty space for a heading/distance ruler; F2 keeps
  it, F3 clears the kept ones.
- Click a tag to select the aircraft (trainers control it from the top bar). Right-click the
  callsign to assume or release it, right-click the destination to show its route.
- Type a value (it appears bottom left) and click CFL, ASP or AHDG on an assumed tag to note it;
  right-click a note to clear it.
- GND and TWR views show the departure and arrival lists. Edits there are shared with everyone.
  A departure leaves the list once it is airborne and climbing through 100 ft.

### Ground movement (trainers)

Select a ground aircraft for PUSH, TAXI, STOP / CONT, FLW, TKOF and CCT. TAXI takes the taxiways
in order (or the shortest path) and a target: a runway hold (named like `B1 07L/25R`), a stand,
"short of" a taxiway, or points picked on the map. The taxiways are read like a clearance: the
aircraft gets onto the first one from wherever it is (off a stand on K, "A A5" goes K, then A,
then A5), follows them in order, and finishes onto the target's own taxiway if the clearance
stops one short of it. A route that crosses a runway stops at that runway's hold bar with
`HOLD SHORT <rwy>`; press **CONT** to cross. At a holding point (or short of a runway crossing)
the aircraft stops with its nose behind the red line. Turns, including the turn at the end of a pushback,
are flown as curves. The planned route is drawn as a dashed line from the aircraft.

On the ground, aircraft keep their distance from the traffic ahead, and at an intersection the
one already in it goes first. Aircraft being pushed back always have priority.

### Command line

Start typing anywhere on the scope; Enter runs it, the up arrow recalls history. Type `.` for
the list of commands.

| Command | What it does |
|---|---|
| `LDARPT ICAO [CTR\|GND\|TWR]` | Load an airport and view |
| `RWYCFG ICAO DEP ARR` | Runway config (extended centrelines) |
| `//CALLSIGN` | Assume / release |
| `FIXES` | Always show fixes |
| `QF` | Flight plan of the selected aircraft |
| `C` | Copy the map coordinates under the cursor |
| `SBPLAY`, `SBPAUSE`, `SBSPEED n` | Clock (trainers) |
| `DEL CS`, `EMER CS` | Delete / toggle an emergency (trainers) |

## Script files (.sbx)

A sweatbox file has a `[sweatbox]` section with its settings, then one event per line. Lines
starting with `#` are comments.

```
[sweatbox]
name = TWR-IRFD-25
airport = IRFD
view = TWR
departure runway = 25L
arrival runways = 25C, 25R
after landing = stand

[00:00] message: text="Rockford tower: clear the arrivals to land."
[00:00] parked: callsign=CEB9740 type=A332 stand=1 level=FL300 route=ATPEV,CLR,DEL to=IZOL climb=3000
[00:20] autodep: callsign=CEB9740 runway=25L
[00:30] airborne: callsign=THA89 type=A333 position=34.031,4.069 altitude=3800 speed=180 level=FL300 route=HDG247 from=IPPH to=IRFD
[00:32] approach: callsign=THA89 runway=25R
```

| Setting | Meaning |
|---|---|
| `airport` | The airport the runways and stands in the file belong to (required) |
| `name` | Optional, for people reading the file (sessions use the file name) |
| `view` | `CTR`, `GND` or `TWR`: what every scope loads (default `CTR`) |
| `departure runway`, `arrival runways` | Optional: the extended centrelines on the scope, and the runways automatic departures move to (in this order) when theirs is busy |
| `after landing` | `remove` (default), `hold` (vacate and wait) or `stand` (taxi in) |

Each event line is `[mm:ss]` (or `[h:mm:ss]`) from the start, the event name and `key=value`
fields in any order. Put values with spaces in quotes. Lines with the same time run in order.
Runways are written as on the airport (`25R`); `position` is a map position `x,y`. A `route` is
a list of fixes (`ATPEV,CLR,DEL`) or a heading (`HDG247`).

| Event | Fields (`[…]` optional) | What happens |
|---|---|---|
| `parked` | `callsign type stand level route to [climb] [airport]` | On a stand, waiting for a pushback |
| `airborne` | `callsign type position altitude speed level route from to` | Flying, at a map position |
| `departing` | `callsign type runway climb level route to [speed]` | Just airborne off a runway |
| `autodep` | `callsign runway [when] [takeoff]` | A parked aircraft pushes and taxis out by itself |
| `approach` | `callsign runway` | Cleared for the approach |
| `autoland` | `callsign` | An airborne aircraft flies its route, then joins a final at its destination and lands by itself |
| `circuit` | `callsign runway side [type] [join]` | Flies circuits |
| `climb` | `callsign altitude` | Initial climb for a departure (the strip's CLMB) |
| `assign` | `callsign [altitude] [speed] [heading]` | An altitude, speed and / or heading |
| `emergency` | `callsign` | Declares an emergency |
| `message` | `text` | A line in everyone's message area |

- `parked … stand=any` takes the next stand that frees up. A parked aircraft whose stand is taken
  waits until it is free, and the callsign's later lines wait with it.
- `autodep` pushes and taxis to a holding point for the runway as soon as that is safe, then
  waits for the controller. With `takeoff=auto` it also crosses runways, lines up and takes off
  by itself. With `when=cleared` it first waits for the strip clearance (C), then does all of that
  by itself (DEL sweatboxes).
- `autoland` makes an aircraft (from `airborne`) fly its route like a departure does: it keeps
  its own separation and then joins a final and lands, until a controller instructs it.
  - At the session airport it uses the `arrival runways`, needs a landing clearance when TWR is
    open, and does whatever `after landing` says.
  - Anywhere else it is removed on touchdown.
- `circuit`: `side=left|right`, `type=touch-and-go|full-stop` (default touch-and-go),
  `join=downwind|on-downwind|base|upwind|crosswind` (default downwind).

Any mistake in the layout rejects the whole file with every bad line listed. Problems the file
can't know about in advance (an unknown fix or stand, an aircraft that isn't there yet) are
warnings: that event is skipped with a log line when it runs.

Files in the old layout (`0 SPAWN …`, `0 CMD LDARPT …`) are no longer loaded. Convert them with
`pnpm sbx:convert path/to/file.sbx` (it keeps the original as `file.sbx.old`).
