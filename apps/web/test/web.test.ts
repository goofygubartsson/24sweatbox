import { beforeAll, describe, expect, it } from "vitest";
import cfg from "@sweatbox/config/public";
import { parseScript } from "@sweatbox/shared";
import { registerTestAirport } from "@sweatbox/shared/testing/itst";
import { completions, parseLine } from "../src/scope/commands";
import { trafficColour, type RAircraft } from "../src/scope/model";
import { draftName, draftScript, emptyDraft, generateItems, validate, type MakerDraft } from "../src/pages/maker/model";

beforeAll(() => {
  registerTestAirport();
});

describe("command line", () => {
  it("parses commands with or without a leading dot, and //CS", () => {
    expect(parseLine(".ldarpt irfd twr")).toEqual({ cmd: "LDARPT", args: ["irfd", "twr"] });
    expect(parseLine("LDARPT IRFD")).toEqual({ cmd: "LDARPT", args: ["IRFD"] });
    expect(parseLine("//BAW1")).toEqual({ cmd: "//", args: ["BAW1"] });
    expect(parseLine("// BAW1")).toEqual({ cmd: "//", args: ["BAW1"] });
  });

  it("autocomplete hides trainer-only commands from everyone else", () => {
    expect(completions(".SB", false)).toEqual([]);
    expect(completions(".SB", true).map((c) => c.label)).toEqual(["SBPLAY", "SBPAUSE", "SBSPEED", "SBLOAD"]);
    expect(completions(".F", false).map((c) => c.label)).toEqual(["FIXES", "FPL"]);
  });
});

describe("traffic colours", () => {
  const ac = (dep: string | null, arr: string | null) => ({ dep, arr }) as RAircraft;
  it("departure / arrival / local / other relative to the loaded airport", () => {
    expect(trafficColour(ac("IRFD", "ITKO"), "IRFD")).toBe(cfg.colours.departure);
    expect(trafficColour(ac("ITKO", "IRFD"), "IRFD")).toBe(cfg.colours.arrival);
    expect(trafficColour(ac("IRFD", "IRFD"), "IPPH")).toBe(cfg.colours.local);
    expect(trafficColour(ac("ITKO", "IPPH"), "IRFD")).toBe(cfg.colours.other);
  });
});

describe("maker", () => {
  it("generated traffic gives a script the server parser accepts", () => {
    const d: MakerDraft = { ...emptyDraft(), apt: "IRFD", position: "APP", runway: "25", durationMin: 20 };
    d.items = generateItems(d);
    expect(d.items.length).toBeGreaterThan(0);
    const gen = draftScript(d)!;
    expect(parseScript(gen.text).errors).toEqual([]);
    expect(draftName(d)).toBe("APP-IRFD-25");
    expect(validate(d, gen).filter((i) => i.level === "error")).toEqual([]);
  });

  it("maps parser errors back to the aircraft and warns about stands used twice", () => {
    const d: MakerDraft = { ...emptyDraft(), apt: "ITST", position: "GND", runway: "27", durationMin: 10 };
    d.items = generateItems(d);
    const parked = d.items.filter((i) => i.kind === "dep-stand");
    expect(parked.length).toBeGreaterThan(1);
    const bad = { ...parked[0]!, cs: "X" };
    const clash = { ...parked[1]!, stand: parked[0]!.stand };
    d.items = d.items.map((i) => (i.id === bad.id ? bad : i.id === clash.id ? clash : i));
    const issues = validate(d, draftScript(d)!);
    expect(issues.find((i) => i.level === "error")?.itemId).toBe(bad.id);
    expect(issues.some((i) => i.text.startsWith(`Stand ITST-${parked[0]!.stand} is used by`))).toBe(true);
  });

  it("refuses positions that need a ground map at airports without one", () => {
    const d: MakerDraft = { ...emptyDraft(), apt: "IPPH", position: "GND", runway: "29" };
    expect(() => generateItems(d)).toThrow("IPPH has no ground map yet, so GND sweatboxes aren't available there");
  });

  it("makes GND traffic at IRFD, parked on its stands", () => {
    const items = generateItems({ ...emptyDraft(), apt: "IRFD", position: "GND", runway: "25" });
    expect(items.some((i) => i.kind === "dep-stand" && i.stand)).toBe(true);
  });
});
