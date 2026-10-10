import { describe, expect, it } from "vitest";
import raw from "../../../sweatbox.config";
import { validateConfig } from "../src/schema";
import { toPublicConfig } from "../src/publicSubset";

describe("sweatbox.config.ts", () => {
  it("is valid and keeps the production defaults", () => {
    const c = validateConfig(raw);
    expect(c.app.publicUrl).toBe("https://sb.atc24academy.com");
    expect(c.app.wsPath).toBe("/api/ws");
    expect(c.session.codeLength).toBe(6);
    expect(c.session.maxSpeed).toBe(15);
    expect(c.sim.unitsPerNm).toBe(3.30714286);
    expect(c.sim.sepLossNm).toBe(1); // separation minimum: 1 NM or 1000 ft
    expect(c.sim.sepLossFt).toBe(1000);
    expect(c.ground.rotateKt).toBe(145);
    expect(c.circuit.altFt).toBe(1000);
    expect(c.twr.goAroundIfNoClearanceNm).toBe(0.6);
  });

  it("fails fast with every bad key named", () => {
    const bad = structuredClone(raw) as unknown as { app: { port: number }; colours: { departure: string }; discord: { guildId: string } };
    bad.app.port = 0;
    bad.colours.departure = "yellow";
    bad.discord.guildId = "abc";
    expect(() => validateConfig(bad)).toThrowError(/app\.port[\s\S]*discord\.guildId[\s\S]*colours\.departure/);
  });

  it("the public subset has no server-only settings", () => {
    const pub = toPublicConfig(validateConfig(raw)) as Record<string, unknown>;
    const json = JSON.stringify(pub);
    expect(pub.discord).toBeUndefined();
    expect(json).not.toContain(raw.discord.guildId);
    expect(json).not.toContain("bindHost");
    expect(json).not.toContain("corsOrigins");
    expect(json).not.toContain("dbPath");
    expect(json).not.toContain("hostControlPerSec");
  });
});
