/**
 * ATC24Academy Sweatbox: the central configuration.
 *
 * Everything that is not a secret lives here: domain, ports, Discord guild/role ids, sim constants,
 * colours, feature flags, limits and file paths. Secrets (Discord credentials, signing secret) live
 * in .env only. See .env.example.
 *
 * The server validates this file with zod at startup (packages/config/src/schema.ts) and refuses to
 * start with a clear message if a value is wrong. The web app receives only the public subset
 * (packages/config/src/public.ts), baked in at build time.
 *
 * Units: distances in NM unless the key says otherwise ("Units" = PTFS map units, 1 NM = unitsPerNm
 * units), altitudes in ft, speeds in kt (ground speed), times in seconds, rates per simulated second.
 */
import type { SweatboxConfigInput } from "./packages/config/src/schema";

const config = {
  app: {
    name: "ATC24Academy Sweatbox",
    shortName: "Sweatbox",
    publicUrl: "https://sb.atc24academy.com",
    apiBase: "/api",
    wsPath: "/api/ws",
    authCallbackPath: "/auth/callback",
    port: 3000, // overridable with PORT in .env
    bindHost: "127.0.0.1", // Caddy proxies to this; use 0.0.0.0 inside Docker (BIND_HOST env)
    corsOrigins: ["https://sb.atc24academy.com", /^http:\/\/localhost(:\d+)?$/],
    trustProxy: true, // behind Caddy: honour X-Forwarded-For for rate limits
    webDistDir: "./apps/web/dist", // served by the API process only when SERVE_WEB=1 (Docker)
  },

  discord: {
    guildId: "1369593726262972487", // users must be members of this guild to log in
    hostRoleIds: ["1452118128845918380"], // any of these roles grants HOST
    ownerIds: ["1072581197454123080"], // always host
    scopes: ["identify", "guilds.members.read"],
    roleRecheckMinutes: 5, // re-check host status at most this often (and on session restore)
    nickSplit: " | ", // nicks look like "RobloxName | Rank": display name = text before this
    apiBase: "https://discord.com/api/v10",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    cdnBase: "https://cdn.discordapp.com",
    requestTimeoutMs: 8000,
  },

  auth: {
    cookieName: "sb_session",
    cookieMaxAgeDays: 30,
    stateMaxAgeSec: 600, // OAuth state nonce lifetime
    reauthBannerText: "Your Discord login expired. Log in again to host.",
  },

  session: {
    codeLength: 6, // case-sensitive session codes...
    codeAlphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", // ...from [A-Za-z]
    idleTimeoutSec: 300, // delete a session this long after the last poll / WS message
    endedRetentionSec: 900, // keep an ended session (and its replay) this long
    minSpeed: 1,
    maxSpeed: 15, // sim seconds per wall second
    tickMs: 1000, // wall-clock tick interval
    maxScriptBytes: 2_000_000,
    logLimit: 200, // session log lines kept in memory
    replayMaxFrames: 20000, // one frame per sim tick
    replayMaxEvents: 50000,
    clientSeenWindowSec: 5, // a client counts as "present" if it pinged within this window (x2 grace)
    pingIntervalSec: 5, // clients send a WS ping this often
    vsWindowSec: 3, // vertical speed and trail are refreshed this often (wall time)
    trailPoints: 5, // history dots per aircraft
    maxAircraft: 200,
    maxSessions: 50, // concurrent sessions on one server
    archiveLongRetention: false, // keep archived replays longer than endedRetentionSec
    archiveLongRetentionDays: 30, // used when archiveLongRetention is true
  },

  sim: {
    unitsPerNm: 3.30714286, // PTFS map units per nautical mile
    ftPerNm: 6076.12,
    climbFtPerSec: 25, // climb and descent rate
    accelKtPerSec: 6, // airborne acceleration / deceleration
    turnDegPerSec: 3, // standard rate turn
    glideslopeDeg: 3,
    approachCaptureMaxDeg: 40, // reject an approach clearance this far off the final course
    approachSnapUnits: 0.1, // snap onto the centreline when this close (map units)
    approachSpeedKt: 130, // speed cap on short final...
    approachSpeedWithinNm: 2, // ...inside this distance
    speedCapBelowFt: 3000, // assigned altitude at or below this...
    speedCapKt: 250, // ...caps the assigned speed
    landedBelowFt: 100, // airborne at or below this (and not flaring) = landed
    sepLossNm: 1, // separation minimum: closer than this laterally...
    parallelRunwayMaxDeg: 10, // ...except two aircraft on approaches to parallel runways (this close in heading)
    sepLossFt: 1000, // ...and vertically, both airborne
    depInitialAltFt: 200, // DEP spawn / ground departure lift-off altitude
    depInitialSpeedKt: 160, // DEP spawn speed
    depSpawnRunwayFraction: 0.6, // DEP spawns this far down the runway
    depJoinRouteAboveFt: 1000, // departures join their route passing this altitude
    defaultDepSpeedKt: 250,
    defaultClimbFt: 3000, // ground departure climb when no CLMB was given
    depStraightOutNm: 8, // empty SID: fly straight out this far
    routeWpMinNm: 1.5, // generated en-route waypoints after the SID are spaced between...
    routeWpMaxNm: 5, // ...these two distances
    gaClimbFt: 3000, // go-around: climb to this...
    gaSpeedKt: 180, // ...at least this fast
    fixPassNm: 0.15, // a fix counts as passed within this distance (0.5 map units)
    arrivalRemoveNm: 2, // homing arrivals are removed this close to their destination
    // departures to another airport fly their route, then join a final there, land and are removed
    autoLandFinalNm: 6, // join the extended centreline this far out
    autoLandSpeedKt: 180, // speed from the end of the route until short final
    // automatic separation: aircraft flying on their own after a ground departure (until a controller
    // instructs them) keep sepLossNm / sepLossFt from everyone. They look ahead along their route and
    // level off below or climb above conflicting traffic, and slow down behind traffic ahead.
    autoSep: {
      lookaheadSec: 90,
      stepSec: 3,
      checkEverySec: 2,
      bufferNm: 0.3, // aim for this much more than the minimum...
      bufferFt: 200, // ...and this
      minAltFt: 1000, // never level off below this to get under traffic (climb above it instead)
      maxAltFt: 10000, // never climb above this to get over traffic
      inTrailDeg: 60, // traffic ahead within this angle of our heading: slow down behind it...
      slowerKt: 10, // ...to this much slower than it
      minSpeedKt: 160, // slowest an aircraft slows down to (approach speed once established on final)
      releaseBufferNm: 0.5, // takeoff release and joining a final: this much more again (turns aren't modelled)
      levelSearchNm: 6, // levels tried: above and below the traffic within this distance
      finalLookaheadSec: 240, // joining a final: look this far down it
    },
    autoLandGapNm: 2, // an auto-landing aircraft holds until the one ahead is this far down the final...
    autoLandHoldOffsetNm: 2.5, // ...this far to the side of its final point, away from the other (arrival) runways
    interceptMaxDeg: 45, // max intercept angle when steering onto a course (circuits, holds)
    interceptDegPerNm: 60, // intercept angle per NM of cross-track error
    flareTouchdownNm: 0.15, // touchdown point past the threshold when rolling out
    hold: {
      defaultLegSec: 60,
      minLegSec: 20,
      maxLegSec: 600,
      minSpeedKt: 60,
      maxSpeedKt: 450,
      defaultTurn: "R",
    },
  },

  ground: {
    accelKtPerSec: 4,
    pushSpeedKt: 13,
    taxiSpeedKt: 18,
    sharpTurnKt: 8, // speed through turns sharper than sharpTurnDeg
    sharpTurnDeg: 45,
    lastPointKt: 5, // speed approaching the end of a taxi route
    decelStopKtPerSec: 2, // normal deceleration to a stop
    decelHoldKtPerSec: 4, // deceleration for "hold position" and spacing
    takeoffAccelKtPerSec: 3,
    rotateKt: 145, // jets; GA types use circuit.gaRotateKt
    maxTakeoffKt: 160,
    lineupMaxDistUnits: 0.35, // TKOF must be this close to a runway entry
    lineupSpeedKt: 8,
    pushMaxUnits: 0.5, // longest custom pushback
    standRemoveAfterSec: 300, // arrivals parked on a stand vanish after this (sim time)
    standCandidates: 6, // STAND rollout: try this many nearest free stands
    autoHoldEntryMaxUnits: 0.3, // AUTO: a hold is valid only with a runway entry this close
    rolloutExitKt: 30, // vacate the runway at this speed
    rolloutDecelKtPerSec: 5,
    rolloutTouchdownKt: 130,
    defaultLengthM: 38, // aircraft length when the type is unknown
    metresPerUnit: 560, // ~1852 / unitsPerNm, used to convert aircraft lengths
    spacingLookaheadUnits: 0.6, // look this far ahead for traffic to keep spacing
    spacingLateralUnits: 0.02, // traffic this close to our path ahead counts as on it
    crossClearUnits: 0.25, // a runway crossing needs this much free path (plus two lengths) beyond the hold
    nearestNodeMaxUnits: 0.4, // snap an aircraft to the graph only this close
    // turns: corners are flown as curves this far either side (shorter on short legs)
    taxiTurnRadiusUnits: 0.025,
    pushTurnRadiusUnits: 0.025,
    turnMinDeg: 12, // corners gentler than this stay as they are
    turnWindowUnits: 0.04, // heading change measured over this distance for the turn speed limit
    // automatic departures (AUTO, and AUTO ... CLR once the strip is cleared)
    autoCheckSec: 4, // how often a waiting aircraft re-checks its push / runway
    autoPushAfterClearSec: 20, // DEL: once the strip is cleared (C), wait this long before pushing back
    autoClearanceUnits: 0.015, // wingtip margin kept from other traffic when pushing
    autoDepIntervalSec: 60, // automatic takeoffs from one runway at least this far apart
    takeoffReleaseFt: 100, // no takeoff roll at an airport until the departure before it is this high
    autoRunwayQueueMax: 5, // automatic departures: a runway with this many queued -> the next runway set
    autoArrivalRunwayQueueMax: 2, // ...at most this many on a runway arrivals use too
    exitClearUnits: 0.08, // landing: an exit with someone this close to its holding point isn't used
    autoDepHoldMaxFraction: 0.5, // departure holds: entries within this share of the runway from its start
    autoQueuePenaltyUnits: 0.3, // each aircraft already heading for a hold counts as this much extra taxi
    autoCrossPenaltyUnits: 1, // each runway to cross on the way to a hold counts as this much extra taxi
    autoArrivalClearNm: 4, // no automatic takeoff with an arrival closer than this on final
    autoCrossArrivalNm: 3, // no automatic runway crossing with an arrival closer than this
    standRefillSec: 90, // a freed stand gets its next queued aircraft after this long
    standClearUnits: 0.03, // a stand counts as taken while an aircraft is this close to it
    holdLineMarginUnits: 0.006, // at a holding point the nose stops this far short of the red line
  },

  circuit: {
    altFt: 1000,
    gaSpeedKt: 90,
    gaRotateKt: 60,
    jetSpeedKt: 150,
    jetRotateKt: 140,
    autoGaNm: 0.15, // circuit traffic without clearance goes around this close (TWR mode)
    extendMaxNm: 7, // an extended leg ends automatically at about this length
    // ICAO types flown as light GA in the circuit (and wake L when unknown)
    gaTypeRegex: "^(C1\\d\\d|C2\\d\\d|PA\\d\\d|P28.|SR2\\d|DA\\d\\d|BE\\d\\d|DHC6|DH6|C208|PC12|PC6)$",
    gaWidthNm: 1.0, // downwind offset from the runway
    jetWidthNm: 2.0,
    gaBaseNm: 1.2, // base leg distance before the threshold
    jetBaseNm: 3.0,
    upwindNm: 0.6, // upwind past the runway end before turning crosswind
    parallelMaxDeg: 10, // runways within this angle count as parallel (pattern side)
  },

  twr: {
    goAroundIfNoClearanceNm: 0.6, // TWR mode: no landing clearance by this distance = go around
    circuitGoAroundNm: 0.15, // ... in the circuit
    gaCircuitJetAltFt: 1500, // automatic circuit after a go-around (non-GA types)
    gaCircuitJetSpeedKt: 160,
  },

  colours: {
    // radar traffic: muted, readable hues (no neon)
    departure: "#d9b54a", // departing the loaded airport
    arrival: "#6fa8dc", // arriving at it
    local: "#a993d6", // departure == arrival
    other: "#d7dbe2",
    selected: "#f3e7a1",
    selectedOnDeparture: "#ffffff", // selected departures show white (they are already yellow)
    emergency: "#e06666",
    // aircraft tags, as on the original sweatbox scope
    tag: {
      unassumed: "#8f8f8f",
      assumed: "#ffffff",
      squawk: "#5fd068",
      leader: "#6f6f6f",
    },
    scope: {
      background: "#0b0d10",
      coastline: "#6f8f7a",
      land: "#141a1c",
      airspace: "#4a515c",
      runway: "#c9ced6",
      runwayLabel: "#8e96a3",
      centreline: "#3d444f",
      fix: "#5f6b7a",
      fixLabel: "#6f7a88",
      navaid: "#7f95a8",
      airport: "#8e96a3",
      route: "#8fb3d9",
      trail: "#6f7a88",
      ruler: "#d9b54a",
      sepLoss: "#e06666",
      pickNode: "#8fb3d980", // ground node highlight in map-pick mode (with alpha)
    },
    // GND / SMC view markings (ground-map spec 2.1)
    ground: {
      land: "#1c1c1c",
      landOutline: "#b1ffbc",
      pavement: "#2c2c2c",
      building: "#0c0c0c",
      buildingOutline: "#3a3a3a",
      runway: "#505050",
      runwayOutline: "#404040",
      runwayNumber: "#e6e6e6",
      taxiline: "#c9a412", // taxiway centreline markings
      standline: "#5e5e5e", // stand lead-in lines
      hold: "#a81c1c", // runway holding-position bars
      label: "#a3a3a3",
      taxiRoute: "#4fd8ff", // planned taxi route of the selected aircraft
    },
    // design tokens, applied to :root at startup (apps/web/src/styles/tokens.css has the same defaults)
    // interface: black, greys and white (the radar and ground map colours above are unchanged)
    theme: {
      background: "#0a0a0a", // pages
      scope: "#0a0a0a", // radar page chrome
      surface: "#141414", // bars, panels, popovers
      surface2: "#1c1c1c", // inputs, hover
      border: "#2e2e2e",
      text: "#ededed",
      muted: "#8f8f8f",
      primary: "#f2f2f2", // primary buttons
      onPrimary: "#0a0a0a",
      danger: "#cf6b6b",
      ok: "#a9b8a9",
    },
    log: {
      info: "#d4d4d4",
      warn: "#cdb37e",
      error: "#cf6b6b",
      comment: "#a8a8a8",
      host: "#c2c2c2",
      cmd: "#9c9c9c",
    },
  },

  ui: {
    tagFontPx: 15, // aircraft tags...
    tagFontWeight: 300, // ...in a regular (not bold) weight: the system monospace renders heavy at 400
    labelFontPx: 10,
    markFontPx: 13, // ruler and Maker marker text
    mapLineWidthPx: 1, // coastline / airspace stroke, CSS px
    fixesMinZoom: 40, // px per map unit at which fixes appear without FIXES
    defaultZoom: 9, // px per map unit
    minZoom: 2,
    maxZoom: 6000,
    gndZoom: 900, // upper limit for the GND view zoom (it fits the airport)
    twrZoom: 160, // upper limit for the TWR view zoom
    viewFit: {
      gndMapFill: 0.92, // GND with a ground map: the paved area fills this share of the screen
      gndRunwayFactor: 2.3, // GND without one: show this multiple of the runway extent
      twrRunwayFactor: 4, // TWR: show this multiple of the runway extent
      minExtentUnits: 0.5, // never fit less than this (map units from the airport reference)
    },
    vectorMinutes: 1, // heading/speed vector length
    tagOffsetPx: [18, -10], // where a tag's bottom-left corner sits from its symbol (drag to move)
    tagTrendFpm: 300, // climb / descent arrow after the altitude beyond this vertical speed
    gndAirborneMaxFt: 1000, // GND view still shows airborne traffic below this...
    gndAirborneMaxNm: 3, // ...within this distance
    twrArrivalMaxFt: 6000, // TWR view keeps tags for arrivals below this...
    twrArrivalMaxNm: 12, // ...within this distance
    messageLines: 8, // bottom-left message area
    depListMaxFt: 100, // GND / TWR departures list: departures leave it climbing through this
    // GND / SMC drawing; widths are screen px (constant at any zoom)
    ground: {
      landOutlinePx: 0.5,
      buildingOutlinePx: 1,
      runwayOutlinePx: 1,
      runwayNumberPx: 14,
      taxilinePx: 1.1,
      standlinePx: 1,
      holdPx: 1.3,
      labelPx: 12,
      labelMinZoom: 60, // labels only at or above this many px per map unit
      taxiRoutePx: 1.6,
      taxiRouteDash: [6, 5],
      twrPavementAlpha: 0.45, // TWR view: pavement and buildings dimmed...
      twrTaxilineAlpha: 0.3, // ...and taxi lines more so; hold bars stay full strength
      defaultRwyHalfWidth: 0.03, // runway half-width when an airport has no ground map
    },
    commandHistory: 100,
    storageVersion: 2, // bump to invalidate per-viewer localStorage (tags, panels)
    makerStorageKey: "sweatbox.maker.draft.v2",
  },

  // Automatic sweatbox files: Airport + Position + Runway format -> a ready-to-load script.
  generator: {
    durationMin: 30, // length of a generated sweatbox
    perMinute: { light: 0.35, normal: 0.6, heavy: 1 }, // aircraft per minute by traffic level...
    rateByPosition: { DEL: 3, GND: 10, TWR: 1, APP: 1, CTR: 1 }, // ...times this for the position
    // these start with every stand occupied; DEL / GND departures added later take the next stand
    // that frees up (TWR: the parked aircraft are all the departures there are)
    fillStands: ["DEL", "GND", "TWR"],
    defaultLevel: "normal",
    autoTaxiAfterSec: 60, // departures added by hand in the Maker push and taxi this long after spawning
    // TWR: every stand starts occupied; they push and taxi to the departure runway's holding point
    // one after another, the first this long after the start...
    twrFirstPushSec: 20,
    // ...then one every 60 / (perMinute x rateByPosition.TWR) seconds; a few of them fly circuits
    twrCircuitAircraft: 2,
    standOccupySec: 120, // a stand counts as in use this long after its aircraft starts pushing
    finalNm: [8, 10, 12, 15], // arrivals on final spawn at one of these distances
    finalSpeedKt: 180,
    arrivalSpacingNm: 4.5, // arrivals on one runway at least this far apart, even at approach speed on short final
    inboundNm: [18, 28], // inbound aircraft spawn between these distances...
    inboundSpreadDeg: 75, // ...within this angle either side of the approach direction
    inboundAltFt: [6000, 10000],
    inboundSpeedKt: 250,
    departureClimbFt: 3000,
    // departure routes: published fixes on the way to the destination, one every routeFixEveryNm...
    routeFixEveryNm: 5,
    routeCorridorNm: 3, // ...at most this far either side of the direct line (or 20% of its length)
    cruiseLevels: ["240", "300", "350"],
    mapLimitUnits: 58, // keep generated positions inside the PTFS map
    airlinerTypes: ["A320", "A321", "B738", "B739", "A332", "A333", "B77W", "B789", "A359", "E190", "CRJ7", "DH8D", "AT76", "B752"],
    gaTypes: ["C172", "P28A", "SR22", "DA40", "C182"],
  },

  data: {
    dir: "./data", // airports, runways, fixes, sectors, ground maps, SIDs, aircraft, callsigns
    scenariosDir: "./data/scenarios",
    generatedDir: "./packages/shared/src/data",
    dbPath: "./var/sweatbox.sqlite",
    scenarioNameRegex: "^[A-Za-z0-9-]+$", // checked AND matched against the directory listing
    scenarioMetaRegex: "^(CTR|APP|GND|TWR|DEL)-([A-Z0-9]{4})(?:-(.+))?$",
  },

  limits: {
    hostControlPerSec: 20, // per user
    stripsPerSec: 10, // per user
    sessionCreatePerMin: 5, // per user
    stripValueMax: 60, // characters
  },

  features: {
    replay: true,
    maker: true,
    ground: true,
    twr: true,
    botRoleCheck: true, // use DISCORD_BOT_TOKEN (if set) for periodic role checks
  },
} satisfies SweatboxConfigInput;

export default config;
