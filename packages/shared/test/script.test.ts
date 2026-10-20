import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCommand, formatHeader, formatTime, parseScript } from "../src/script";
import { convertLegacyScript } from "../src/scriptLegacy";

const HEAD = ["[sweatbox]", "airport = IRFD"];
const file = (...events: string[]) => [...HEAD, ...events].join("\n");

describe("parseScript", () => {
  it("reads the [sweatbox] settings and every event", () => {
    const r = parseScript(
      [
        "# comment",
        "",
        "[sweatbox]",
        "name = TWR-IRFD-25",
        "airport = IRFD",
        "view = TWR",
        "departure runway = 25R",
        "arrival runways = 25L, 25C",
        "after landing = stand",
        "",
        "[00:00] airborne: callsign=BAW3847 type=A333 position=34.496,4.546 altitude=4000 speed=210 level=FL270 route=HDG247 from=ITKO to=IRFD",
        "[00:05] approach: callsign=BAW3847 runway=25L",
        "[00:10] departing: callsign=EZY45 type=A320 runway=25R climb=4000 level=240 route=HDG250 to=ISAU",
        "[00:11] departing: callsign=RYR1 type=B738 runway=IRFD-25R climb=4000 level=FL260 route=KENED2.JOOPY,POPPY to=IMLR speed=230",
        "[00:12] parked: callsign=DLH12 type=A320 stand=5 level=FL300 route=HDG090 to=ITKO climb=5000",
        "[00:12] parked: callsign=N12 type=C172 stand=any level=FL010 route=CCT to=IRFD",
        "[00:14] circuit: callsign=N12 runway=25C side=left type=full-stop join=base",
        "[00:15] climb: callsign=DLH12 altitude=6000",
        "[00:17] assign: callsign=BAW3847 altitude=3000 speed=180 heading=0",
        "[00:18] emergency: callsign=BAW3847",
        '[00:19] message: text="Hello   world"',
        "[1:00:00] message: text=An hour in",
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.header).toEqual({ name: "TWR-IRFD-25", airport: "IRFD", view: "TWR", depRunway: "25R", arrRunways: ["25L", "25C"], afterLanding: "STAND" });
    expect(r.commands.map((c) => c.kind)).toEqual([
      // the settings: everyone's scope view and runways, what happens after landing
      "CMD", "CMD", "ROLLOUT",
      "SPAWN", "APPR", "DEP", "DEP", "GATE", "CLMB", "GATE", "CCT", "CLMB", "ALT", "SPD", "HDG", "EMERGENCY", "COMMENT", "COMMENT",
    ]);
    expect(r.commands[0]).toMatchObject({ kind: "CMD", text: "LDARPT IRFD TWR", offset: 0 });
    expect(r.commands[1]).toMatchObject({ kind: "CMD", text: "RWYCFG IRFD 25R 25L,25C" });
    expect(r.commands[2]).toMatchObject({ kind: "ROLLOUT", mode: "STAND" });
    expect(r.commands[3]).toMatchObject({ kind: "SPAWN", cs: "BAW3847", type: "A333", alt: 4000, rfl: "270", gs: 210, route: "HDG247", dep: "ITKO", arr: "IRFD", x: 34.496, y: 4.546, line: 11 });
    expect(r.commands[4]).toMatchObject({ kind: "APPR", runway: "IRFD-25L", offset: 5 });
    expect(r.commands[5]).toMatchObject({ kind: "DEP", runway: "IRFD-25R", rfl: "240", spd: 250 });
    expect(r.commands[6]).toMatchObject({ kind: "DEP", spd: 230, route: "KENED2.JOOPY,POPPY" });
    expect(r.commands[7]).toMatchObject({ kind: "GATE", apt: "IRFD", stand: "5", arr: "ITKO" });
    expect(r.commands[8]).toMatchObject({ kind: "CLMB", cs: "DLH12", ft: 5000 });
    expect(r.commands[9]).toMatchObject({ kind: "GATE", stand: "*", route: "CCT", rfl: "010" });
    expect(r.commands[10]).toMatchObject({ kind: "CCT", side: "L", tng: false, join: "BASE" });
    expect(r.commands[14]).toMatchObject({ kind: "HDG", value: 360 });
    expect(r.commands[16]).toMatchObject({ kind: "COMMENT", text: "Hello   world" });
    expect(r.commands[17]).toMatchObject({ kind: "COMMENT", text: "An hour in", offset: 3600 });
  });

  it("circuits default to touch-and-go joining downwind; the view to CTR; nothing after landing", () => {
    const r = parseScript(file("[00:00] circuit: callsign=N1 runway=25C side=right"));
    expect(r.header).toMatchObject({ view: "CTR", afterLanding: null, depRunway: null });
    expect(r.commands.map((c) => c.kind)).toEqual(["CMD", "CCT"]);
    expect(r.commands[1]).toMatchObject({ kind: "CCT", side: "R", tng: true, join: "DW" });
  });

  it("runs lines with the same time in file order", () => {
    const r = parseScript(file('[00:10] message: text=b', '[00:00] message: text=a', '[00:10] message: text=c', '[00:05] message: text=d'));
    expect(r.commands.filter((c) => c.kind === "COMMENT").map((c) => (c.kind === "COMMENT" ? c.text : ""))).toEqual(["a", "d", "b", "c"]);
  });

  it("rejects the whole file and reports every bad line", () => {
    const r = parseScript(
      file(
        "[00:00] message: text=fine",
        "[00:00] airborne: callsign=X",
        "[0:61] message: text=x",
        "[00:00] airborne: callsign=BAW1 type=A320 position=1,2 altitude=3000 speed=250 level=FL300 route=HDGxx from=IRFD to=ITKO",
        "[00:00] fly: callsign=BAW1",
        "[00:00] circuit: callsign=N1 runway=25 side=up",
        "[00:00] approach: callsign=BAW1 runway=25L wind=calm",
        "[00:00] approach callsign=BAW1",
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.commands).toEqual([]);
    expect(r.errors).toEqual([
      "Line 4: airborne needs type, position, altitude, speed, level, route, from, to (callsign=… type=… position=… altitude=… speed=… level=… route=… from=… to=…)",
      'Line 5: invalid time "[0:61]" (seconds 00-59)',
      'Line 6: invalid HDG route "HDGxx"',
      'Line 7: unknown event "fly" (parked, airborne, departing, approach, circuit, climb, assign, emergency, message)',
      'Line 8: invalid side "up" (left, right)',
      'Line 9: approach has no field "wind" (callsign=… runway=…)',
      'Line 10: expected "[mm:ss] event: key=value …" (settings go before the first event)',
    ]);
    expect(r.errorLines).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it("validates values", () => {
    const bad = [
      ["[00:00] airborne: callsign=BAW1 type=A320 position=1,2 altitude=3000 speed=250 level=FL300 route=HDG400 from=IRFD to=ITKO", 'invalid HDG route "HDG400"'],
      ["[00:00] departing: callsign=BAW1 type=A320 runway=IRFD25L climb=3000 level=300 route=HDG250 to=ITKO", 'invalid runway "IRFD25L"'],
      ["[00:00] parked: callsign=BAW1 type=A320 stand=5? level=300 route=HDG250 to=ITKO", 'invalid stand "5?"'],
      ["[00:00] assign: callsign=BAW1 altitude=high", 'invalid altitude "high"'],
      ["[00:00] assign: callsign=BAW1", "assign needs altitude, speed or heading"],
      ["[00:00] airborne: callsign=B type=A320 position=1,2 altitude=3000 speed=250 level=300 route=HDG250 from=IRFD to=ITKO", 'invalid callsign "B"'],
      ["[00:00] airborne: callsign=BAW1 type=A320 position=1,two altitude=3000 speed=250 level=300 route=HDG250 from=IRFD to=ITKO", 'invalid coordinate "two"'],
      ["[00:00] autodep: callsign=BAW1 runway=25R", 'unknown event "autodep"'],
      ["[00:00] approach: callsign=BAW1 runway=25L callsign=BAW2", "callsign given twice"],
      ["[00:00] message:", 'message needs text="…"'],
    ] as const;
    for (const [line, msg] of bad) {
      const r = parseScript(file(line));
      expect(r.ok, line).toBe(false);
      expect(r.errors[0], line).toContain(msg);
    }
  });

  it("checks the settings", () => {
    expect(parseScript("[sweatbox]\nview = TWR\n[00:00] message: text=x").errors[0]).toContain("[sweatbox] needs airport");
    expect(parseScript("[sweatbox]\nairport = IRFD\nview = APP\n[00:00] message: text=x").errors[0]).toContain('invalid view "APP"');
    expect(parseScript("[sweatbox]\nairport = IRFD\nafter landing = park\n[00:00] message: text=x").errors[0]).toContain('invalid after landing "park"');
    expect(parseScript("[sweatbox]\nairport = IRFD\nwind = 250/10\n[00:00] message: text=x").errors[0]).toContain('unknown setting "wind"');
    expect(parseScript("[sweatbox]\nairport = IRFD").errors).toEqual(["Line 2: the file has no events"]);
    expect(parseScript("[00:00] message: text=x").errors).toEqual(["Line 1: the file must start with [sweatbox]"]);
    expect(parseScript("# nothing\n\n").errors[0]).toContain("the file is empty");
  });

  it("rejects the old layout with a pointer to the converter", () => {
    const r = parseScript("# old\n0 CMD LDARPT IRFD TWR\n0 SPAWN BAW1 A320 3000 300 250 HDG250 ITKO IRFD 1 2");
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^Line 2: this is an old-format sweatbox file.*pnpm sbx:convert/);
  });

  it("warns (but accepts) unknown runways, fixes and aircraft that aren't there yet", () => {
    const r = parseScript(file("[00:00] approach: callsign=NOPE1 runway=99", "[00:01] airborne: callsign=A1 type=A320 position=1,2 altitude=3000 speed=250 level=300 route=NOSUCH,FIX from=IRFD to=ITKO"));
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain("Line 3: unknown runway IRFD-99");
    expect(r.warnings.some((w) => w.startsWith("Line 3: NOPE1 isn't there yet"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("unknown fix or SID NOSUCH"))).toBe(true);
  });

  it("writes events and settings back the same way", () => {
    const header = { name: "X", airport: "IRFD", view: "GND" as const, depRunway: "25R", arrRunways: ["25L", "25C"], afterLanding: "HOLD" as const };
    const events = [
      "[00:00] airborne: callsign=BAW3847 type=A333 position=34.496,4.546 altitude=4000 speed=210 level=FL270 route=HDG247 from=ITKO to=IRFD",
      "[00:10] departing: callsign=EZY45 type=A320 runway=25R climb=4000 level=FL240 route=HDG250 to=ISAU",
      "[00:11] departing: callsign=RYR1 type=B738 runway=25R climb=4000 level=FL260 route=POPPY to=IMLR speed=230",
      "[00:12] parked: callsign=DLH12 type=A320 stand=5 level=FL300 route=HDG090 to=ITKO",
      "[00:12] parked: callsign=DLH13 type=A320 stand=any level=FL300 route=HDG090 to=ITKO airport=IPPH",
      "[00:14] circuit: callsign=N12 runway=25C side=left type=full-stop join=base",
      "[00:15] assign: callsign=BAW3847 heading=270",
      '[00:19] message: text="Hello world"',
    ];
    const text = [...formatHeader(header), "", ...events].join("\n");
    const r = parseScript(text);
    expect(r.header).toEqual(header);
    expect(r.commands.map((c) => formatCommand(c, "IRFD")).filter(Boolean)).toEqual(events);
    expect(formatTime(3725)).toBe("[1:02:05]");
  });

  it("parses the shipped scenarios", () => {
    const dir = path.resolve(__dirname, "../../../data/scenarios");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sbx"))) {
      const r = parseScript(fs.readFileSync(path.join(dir, f), "utf8"));
      expect(r.errors, f).toEqual([]);
    }
  });
});

describe("converting old files", () => {
  it("turns the old line layout into the [sweatbox] layout", () => {
    const old = [
      "# a demo",
      "0 CMD LDARPT IRFD TWR",
      "0 CMD RWYCFG IRFD 25R 25L,25C",
      "0 ROLLOUT STAND",
      "0 SPAWN BAW1 A320 3000 300 180 HDG247 ITKO IRFD 28.41 7.135",
      "2 APPR BAW1 IRFD-25L",
      "10 GATE AAL1 A320 IRFD-* 300 HDG090 IPPH",
      "10 CLMB AAL1 4000",
      "10 AUTO AAL1 IRFD-25R CLR",
      "60 CMD FIXES",
      "70 COMMENT Last one.",
    ].join("\n");
    const { text, notes } = convertLegacyScript(old, "TWR-IRFD-DEMO");
    expect(text).toBe(
      [
        "# a demo",
        "",
        "[sweatbox]",
        "name = TWR-IRFD-DEMO",
        "airport = IRFD",
        "view = TWR",
        "departure runway = 25R",
        "arrival runways = 25L, 25C",
        "after landing = stand",
        "",
        '# dropped "10 AUTO AAL1 IRFD-25R CLR" (automatic departures are no longer part of the sim)',
        '# dropped "60 CMD FIXES" (scope commands are now the [sweatbox] settings)',
        "[00:00] airborne: callsign=BAW1 type=A320 position=28.41,7.135 altitude=3000 speed=180 level=FL300 route=HDG247 from=ITKO to=IRFD",
        "[00:02] approach: callsign=BAW1 runway=25L",
        "[00:10] parked: callsign=AAL1 type=A320 stand=any level=FL300 route=HDG090 to=IPPH",
        "[00:10] climb: callsign=AAL1 altitude=4000",
        '[01:10] message: text="Last one."',
        "",
      ].join("\n"),
    );
    expect(notes).toHaveLength(2); // the CMD, and the AUTO line (automatic departures are gone)
    expect(parseScript(text).errors).toEqual([]);
  });
});
