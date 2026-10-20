// Static world data (airports, runways, fixes, SIDs, ground maps...) loaded from the JSON that
// scripts/build-data.ts generates. Shared by the server and the web app.
import airportsJson from "./data/airports.json";
import runwaysJson from "./data/runways.json";
import fixesJson from "./data/fixes.json";
import sidsJson from "./data/sids.json";
import aircraftJson from "./data/aircraft.json";
import callsignsJson from "./data/callsigns.json";
import outlinesJson from "./data/outlines.json";
import sectorsJson from "./data/sectors.json";
import msaJson from "./data/msa.json";
import groundJson from "./data/ground.json";
import groundArtJson from "./data/groundArt.json";
import type {
  AircraftData,
  Airport,
  CallsignData,
  FixData,
  GroundArt,
  GroundMapData,
  Outlines,
  RunwayPairData,
  MsaArea,
  Sectors,
  SidTable,
} from "./dataTypes";
import { toVec, type Vec } from "./geometry";

export interface Fix {
  name: string;
  type: string;
  pos: Vec;
  layer: FixData["layer"];
}

export interface RunwayPair {
  icao: string;
  name1: string;
  name2: string;
  position1: Vec;
  position2: Vec;
  /** "07C/25C": the designators of name1/name2, as used by ground maps. */
  pair: string;
}

export const airports: Airport[] = airportsJson as unknown as Airport[];
export const runwayPairs: RunwayPair[] = (runwaysJson as unknown as RunwayPairData[]).map((r) => ({
  icao: r.icao,
  name1: r.name1,
  name2: r.name2,
  position1: toVec(r.position1),
  position2: toVec(r.position2),
  pair: `${r.name1.split("-")[1]}/${r.name2.split("-")[1]}`,
}));
export const fixes: Fix[] = (fixesJson as unknown as FixData[]).map((f) => ({ ...f, pos: toVec(f.pos) }));
export const sids: SidTable = sidsJson as unknown as SidTable;
export const aircraftData: AircraftData = aircraftJson as unknown as AircraftData;
export const callsignData: CallsignData = callsignsJson as unknown as CallsignData;
export const outlines: Outlines = outlinesJson as unknown as Outlines;
export const sectors: Sectors = sectorsJson as unknown as Sectors;
export const msaAreas: MsaArea[] = msaJson as unknown as MsaArea[];
export const groundMapsData: Record<string, GroundMapData> = groundJson as unknown as Record<string, GroundMapData>;
export const groundArt: Record<string, GroundArt> = groundArtJson as unknown as Record<string, GroundArt>;

const airportByCode = new Map(airports.map((a) => [a.code, a]));
const fixByName = new Map(fixes.map((f) => [f.name, f]));

export const getAirport = (code: string): Airport | undefined => airportByCode.get(code.toUpperCase());
export const getFix = (name: string): Fix | undefined => fixByName.get(name.toUpperCase());

/** Airport reference point: the average of all runway endpoints for that ICAO. */
export function airportRef(code: string): Vec | null {
  const a = getAirport(code);
  return a?.centre ? toVec(a.centre) : null;
}

export function runwaysOf(icao: string): RunwayPair[] {
  return runwayPairs.filter((r) => r.icao === icao.toUpperCase());
}

/** Every runway end name ("IRFD-25L") for an airport, or for all airports. */
export function runwayEndNames(icao?: string): string[] {
  const list = icao ? runwaysOf(icao) : runwayPairs;
  return list.flatMap((r) => [r.name1, r.name2]);
}

/** True when the airport's ground map includes its taxi graph (DEL / GND traffic needs it). */
export function hasGroundMap(icao: string): boolean {
  return Boolean(groundMapsData[icao.toUpperCase()]?.ground);
}

/** An airport's ground layout for drawing, with or without its taxi graph. */
export const groundLayout = (icao: string): GroundMapData | undefined => groundMapsData[icao.toUpperCase()];

/** Add an airport at runtime (tests use a synthetic airport). */
export function registerAirport(a: Airport): void {
  if (!airportByCode.has(a.code)) airports.push(a);
  airportByCode.set(a.code, a);
}

/** Add a ground map at runtime (tests). */
export function registerGroundMapData(icao: string, data: GroundMapData): void {
  groundMapsData[icao.toUpperCase()] = data;
}
