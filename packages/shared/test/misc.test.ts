import { describe, expect, it } from "vitest";
import { isGaType, robloxToIcao, wakeOf } from "../src/aircraftTypes";
import { normalizeCallsign, radioCallsign } from "../src/callsigns";
import { flightLevelString, formatClock, heading3, hundreds, parseAltitudeInput } from "../src/format";
import { squawkFor } from "../src/squawk";
import { expandRoute, routeHeading } from "../src/routes";

describe("aircraft types", () => {
  it("maps Roblox names to ICAO and strips Cargo", () => {
    expect(robloxToIcao("Boeing 737")).toBe("B738");
    expect(robloxToIcao("Boeing 737 Cargo")).toBe("B738");
    expect(robloxToIcao("Piper PA28")).toBe("P28A");
    expect(robloxToIcao("boeing 777 CARGO")).toBe("B77W");
    expect(robloxToIcao("A320")).toBe("A320");
  });
  it("light GA is always L, never undefined", () => {
    for (const t of ["C172", "P28A", "SR22", "DA40", "PA28", "C152", "BE36", "PC12", "C208"]) expect(wakeOf(t)).toBe("L");
    expect(wakeOf("C177")).toBe("L"); // unknown, but matches the GA regex
    expect(wakeOf("XYZ1")).toBe("M");
    expect(wakeOf("A388")).toBe("J");
    expect(wakeOf("B77W")).toBe("H");
  });
  it("GA regex", () => {
    expect(isGaType("C172")).toBe(true);
    expect(isGaType("A320")).toBe(false);
  });
});

describe("callsigns", () => {
  it('normalises "Name-123" to ICAO123', () => {
    expect(normalizeCallsign("Speedbird-123")).toBe("BAW123");
    expect(normalizeCallsign("speedbird-12A")).toBe("BAW12A");
    expect(normalizeCallsign("Lifthansa-4")).toBe("DLH4");
    expect(normalizeCallsign("LUFTHANSA-4")).toBe("DLH4"); // real radio name
    expect(normalizeCallsign("Air Canadian-881")).toBe("ACA881");
    expect(normalizeCallsign("N172SP")).toBe("N172SP");
    expect(normalizeCallsign("Unknownair-77")).toBe("UNKNOWNAIR77");
  });
  it("radio callsigns", () => {
    expect(radioCallsign("BAW3847")).toBe("SPEEDBIRD 3847");
    expect(radioCallsign("ZZZ1")).toBeNull();
  });
});

describe("squawks", () => {
  it("are stable, octal, and never 7xxx / 1000 / 2000", () => {
    expect(squawkFor("BAW3847")).toBe(squawkFor("baw3847"));
    for (let i = 0; i < 5000; i++) {
      const s = squawkFor(`T${i}`);
      expect(s).toMatch(/^[0-6][0-7]{3}$/);
      expect(["1000", "2000", "0000"]).not.toContain(s);
    }
  });
});

describe("format", () => {
  it("altitude input: under 1000 = flight level", () => {
    expect(parseAltitudeInput("80")).toBe(8000);
    expect(parseAltitudeInput("FL80")).toBe(8000);
    expect(parseAltitudeInput("fl080")).toBe(8000);
    expect(parseAltitudeInput("8000")).toBe(8000);
    expect(parseAltitudeInput("350")).toBe(35000);
    expect(parseAltitudeInput("abc")).toBeNull();
  });
  it("helpers", () => {
    expect(hundreds(3000)).toBe("030");
    expect(flightLevelString("FL40")).toBe("040");
    expect(formatClock(312)).toBe("05:12");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(heading3(0)).toBe("360");
    expect(heading3(5)).toBe("005");
  });
});

describe("routes", () => {
  it("HDG routes", () => {
    expect(routeHeading("HDG250")).toBe(250);
    expect(routeHeading("ANTNY,ROMNS")).toBeNull();
    expect(expandRoute("HDG090", {}).heading).toBe(90);
  });
  it("fix lists", () => {
    const r = expandRoute("ANTNY,ROMNS DCT NARXX ZZZZZ", {});
    expect(r.points.map((p) => p.name)).toEqual(["ANTNY", "ROMNS", "NARXX"]);
    expect(r.unknown).toEqual(["ZZZZZ"]);
  });
});
