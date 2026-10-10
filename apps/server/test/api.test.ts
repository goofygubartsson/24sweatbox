import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { loadEnv, repoRoot } from "../src/env";
import { Store } from "../src/db";
import { Secrets } from "../src/crypto";
import { DiscordClient } from "../src/auth/discord";
import { AuthService } from "../src/auth/service";
import { SessionManager } from "../src/sessions/manager";
import { ScenarioLibrary } from "../src/sessions/scenarios";
import { RateLimiter } from "../src/rateLimit";
import { buildApp, rewriteUrl } from "../src/app";
import { attachWebSocket } from "../src/ws";
import { safeNext } from "../src/auth/routes";
import type { Deps } from "../src/deps";

let app: FastifyInstance;
let deps: Deps;
let hostToken = "";
let viewerToken = "";

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: "development", DEV_FAKE_USER: "", DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", DISCORD_REDIRECT_URI: "" });
  env.NODE_ENV = "test";
  const store = new Store(":memory:");
  const secrets = new Secrets("test-secret-test-secret-test-secret-0123456789");
  const discord = new DiscordClient(env);
  deps = {
    env,
    store,
    secrets,
    discord,
    auth: new AuthService(store, env, discord, secrets),
    sessions: new SessionManager(store),
    scenarios: new ScenarioLibrary(path.resolve(repoRoot(), "data/scenarios")),
    limiter: new RateLimiter(),
  };
  app = await buildApp(deps);
  const h = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { as: "host", name: "Hosty" } });
  hostToken = h.json().token;
  const v = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { as: "viewer", name: "Viewy" } });
  viewerToken = v.json().token;
});

afterAll(async () => {
  await app.close();
  deps.store.close();
});

describe("auth", () => {
  it("401 without a session", async () => {
    const r = await app.inject({ url: "/api/me" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "Log in with Discord first", code: "NOT_LOGGED_IN" });
  });

  it("dev login sets an httpOnly cookie and /api/me works with it or a bearer token", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { as: "host", name: "Cookie" } });
    const cookie = r.cookies.find((c) => c.name === "sb_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    const me = await app.inject({ url: "/api/me", cookies: { sb_session: cookie.value } });
    expect(me.json()).toMatchObject({ displayName: "Cookie", isHost: true, reauth: false });
    const me2 = await app.inject({ url: "/api/me", headers: auth(viewerToken) });
    expect(me2.json()).toMatchObject({ displayName: "Viewy", isHost: false });
  });

  it("logout clears the session", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { as: "viewer", name: "Bye" } });
    const t = r.json().token;
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: auth(t) })).statusCode).toBe(204);
    expect((await app.inject({ url: "/api/me", headers: auth(t) })).statusCode).toBe(401);
  });

  it("Discord login redirects to the home page with an error when not configured", async () => {
    const r = await app.inject({ url: "/api/auth/discord?next=/s/AbCdEf" });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/?login_error=discord_error");
  });

  it("the callback rejects a bad state", async () => {
    const r = await app.inject({ url: "/auth/callback?code=x&state=nope" });
    expect(r.headers.location).toBe("/?login_error=bad_state");
  });

  it("next must be a same-site path", () => {
    expect(safeNext("/s/AbCdEf")).toBe("/s/AbCdEf");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\\evil")).toBe("/");
  });
});

describe("sessions", () => {
  let code = "";

  it("only hosts create sessions", async () => {
    const v = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(viewerToken), payload: {} });
    expect(v.statusCode).toBe(403);
    expect(v.json().code).toBe("NOT_HOST");
    const h = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(hostToken), payload: {} });
    expect(h.statusCode).toBe(201);
    code = h.json().code;
    expect(code).toMatch(/^[A-Za-z]{6}$/);
  });

  it("Create Sweatbox generates and loads a sweatbox from airport, position and runway format", async () => {
    const r = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(hostToken), payload: { generate: { apt: "IRFD", position: "TWR", runway: "25" } } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({ scriptName: "TWR-IRFD-25" });
    expect(body.commandCount).toBeGreaterThan(5);
    const s = deps.sessions.get(body.code)!;
    expect(s.scriptName).toBe("TWR-IRFD-25");
    expect(s.running).toBe(false);
    // load another one into the same session
    const again = await app.inject({ method: "POST", url: `/api/sessions/${body.code}/script`, headers: auth(hostToken), payload: { generate: { apt: "IPPH", position: "APP", runway: "29" } } });
    expect(again.json()).toMatchObject({ scriptName: "APP-IPPH-29" });
  });

  it("explains settings that can't be generated", async () => {
    const gnd = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(hostToken), payload: { generate: { apt: "IPPH", position: "GND", runway: "29" } } });
    expect(gnd.statusCode).toBe(409);
    expect(gnd.json()).toEqual({ error: "IPPH has no ground map yet, so GND sweatboxes aren't available there", code: "REJECTED" });
    const irfd = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(hostToken), payload: { generate: { apt: "IRFD", position: "GND", runway: "25" } } });
    expect(irfd.statusCode).toBe(201);
    expect(irfd.json().scriptName).toBe("GND-IRFD-25");
    const rwy = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(hostToken), payload: { generate: { apt: "IRFD", position: "TWR", runway: "18" } } });
    expect(rwy.statusCode).toBe(400);
    expect(rwy.json().error).toBe("IRFD has no runway 18");
    const viewer = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(viewerToken), payload: { generate: { apt: "IRFD", position: "TWR", runway: "25" } } });
    expect(viewer.statusCode).toBe(403);
  });

  it("gets session info, 404 for unknown codes", async () => {
    const r = await app.inject({ url: `/api/sessions/${code}`, headers: auth(viewerToken) });
    expect(r.json()).toMatchObject({ code, scriptName: null, running: false, speed: 1, elapsedSec: 0, ended: false });
    const bad = await app.inject({ url: "/api/sessions/zzzzzz", headers: auth(viewerToken) });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().code).toBe("NO_SESSION");
  });

  it("lists scenarios with POS-APT-RWY metadata", async () => {
    const r = await app.inject({ url: "/api/scenarios", headers: auth(hostToken) });
    expect(r.json()).toContainEqual({ name: "APP-IRFD-DEMO", pos: "APP", apt: "IRFD", rwy: "DEMO" });
    const t = await app.inject({ url: "/api/scenarios/APP-IRFD-DEMO", headers: auth(hostToken) });
    expect(t.headers["content-type"]).toContain("text/plain");
    expect(t.body).toContain("[sweatbox]");
    expect(t.body).toContain("] airborne: callsign=");
  });

  it("refuses path traversal in scenario names", async () => {
    for (const name of ["..%2F..%2Fpackage", "..", "APP-IRFD-DEMO.sbx", "app-irfd-demo"]) {
      const r = await app.inject({ url: `/api/scenarios/${name}`, headers: auth(hostToken) });
      expect(r.statusCode, name).toBe(404);
    }
    const b = await app.inject({ method: "POST", url: `/api/sessions/${code}/script`, headers: auth(hostToken), payload: { name: "../../package" } });
    expect(b.statusCode).toBe(400);
    expect(b.json().code).toBe("BAD_INPUT");
  });

  it("422 with every bad line for a broken script", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/sessions/${code}/script`,
      headers: auth(hostToken),
      payload: { text: "[sweatbox]\nairport = IRFD\n[00:00] airborne: callsign=X\n[00:01] assign: callsign=BAW1 heading=999", label: "Broken" },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({
      code: "SCRIPT_ERRORS",
      errors: [
        "Line 3: airborne needs type, position, altitude, speed, level, route, from, to (callsign=… type=… position=… altitude=… speed=… level=… route=… from=… to=…)",
        "Line 4: heading 999 out of range (0-360)",
      ],
    });
  });

  it("loads a script by name and runs the clock", async () => {
    const r = await app.inject({ method: "POST", url: `/api/sessions/${code}/script`, headers: auth(hostToken), payload: { name: "APP-IRFD-DEMO" } });
    expect(r.json().commandCount).toBeGreaterThan(5);
    const c = await app.inject({ method: "POST", url: `/api/sessions/${code}/clock`, headers: auth(hostToken), payload: { speed: 99 } });
    expect(c.json()).toEqual({ running: false, speed: 15 });
    const p = await app.inject({ method: "POST", url: `/api/sessions/${code}/clock`, headers: auth(hostToken), payload: { action: "play" } });
    expect(p.json()).toEqual({ running: true, speed: 15 });
    const v = await app.inject({ method: "POST", url: `/api/sessions/${code}/clock`, headers: auth(viewerToken), payload: { action: "pause" } });
    expect(v.statusCode).toBe(403);
    deps.sessions.tickAll();
    const st = await app.inject({ url: `/api/sessions/${code}/state`, headers: auth(viewerToken) });
    const snap = st.json();
    expect(snap.t).toBe("snapshot");
    expect(snap.elapsedSec).toBe(15);
    expect(snap.aircraft.length).toBeGreaterThan(0);
    expect(snap.aircraft[0].gnd).toBeNull();
    expect(snap.clients).toBeUndefined(); // viewers don't see the client list
    expect(snap.log.some((l: { message: string }) => l.message.startsWith('Loaded script "APP-IRFD-DEMO"'))).toBe(true);
  });

  it("host aircraft control: validation, 404s, 409s and the audit", async () => {
    const s = deps.sessions.get(code)!;
    const ac = s.aircraft.find((a) => !a.onGround)!;
    const url = (k: string, id = ac.id) => `/api/sessions/${code}/aircraft/${id}/${k}`;
    const two = await app.inject({ method: "POST", url: url("air"), headers: auth(hostToken), payload: { alt: 5000, hdg: 90 } });
    expect(two.statusCode).toBe(400);
    const none = await app.inject({ method: "POST", url: url("air", "00000000-0000-4000-8000-000000000000"), headers: auth(hostToken), payload: { alt: 5000 } });
    expect(none.statusCode).toBe(404);
    expect(none.json().code).toBe("NO_AIRCRAFT");
    const viewer = await app.inject({ method: "POST", url: url("air"), headers: auth(viewerToken), payload: { alt: 5000 } });
    expect(viewer.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: url("air"), headers: auth(hostToken), payload: { alt: 5000 } });
    expect(ok.json()).toMatchObject({ ok: true, aircraft: { assigned: { alt: 5000 } } });
    const fix = await app.inject({ method: "POST", url: url("air"), headers: auth(hostToken), payload: { dct: ["NOPE1"] } });
    expect(fix.statusCode).toBe(400);
    expect(fix.json().error).toBe("Unknown fix NOPE1");
    const gnd = await app.inject({ method: "POST", url: url("gnd"), headers: auth(hostToken), payload: { action: "stop" } });
    expect(gnd.statusCode).toBe(409);
    expect(gnd.json()).toEqual({ error: "Aircraft is not on the ground", code: "REJECTED" });
    const land = await app.inject({ method: "POST", url: url("twr"), headers: auth(hostToken), payload: { action: "xhold" } });
    expect(land.json()).toEqual({ error: "Not holding", code: "REJECTED" });
    expect(s.logEntries.some((l) => l.message === `HOST ALT ${ac.callsign} → 5000` && l.level === "host")).toBe(true);
    expect(s.counters.hostCmds.ALT).toBe(1);
  });

  it("strips are shared, upper-cased and capped at 60 characters", async () => {
    const r = await app.inject({ method: "POST", url: `/api/sessions/${code}/strips`, headers: auth(viewerToken), payload: { callsign: "baw3847", key: "rmk", value: "x".repeat(80) } });
    expect(r.statusCode).toBe(204);
    const bad = await app.inject({ method: "POST", url: `/api/sessions/${code}/strips`, headers: auth(viewerToken), payload: { callsign: "BAW3847", key: "evil", value: "x" } });
    expect(bad.statusCode).toBe(400);
    const s = deps.sessions.get(code)!;
    expect(s.strips.BAW3847!.rmk).toBe("X".repeat(60));
    await app.inject({ method: "POST", url: `/api/sessions/${code}/strips`, headers: auth(viewerToken), payload: { callsign: "BAW3847", key: "rmk", value: "" } });
    expect(s.strips.BAW3847).toBeUndefined();
  });

  it("toggles TWR mode", async () => {
    const r = await app.inject({ method: "POST", url: `/api/sessions/${code}/twr`, headers: auth(hostToken), payload: { on: true } });
    expect(r.json()).toEqual({ twr: true });
  });

  it("ends idempotently, serves the replay and refuses play afterwards", async () => {
    const e1 = await app.inject({ method: "POST", url: `/api/sessions/${code}/end`, headers: auth(hostToken), payload: {} });
    const e2 = await app.inject({ method: "POST", url: `/api/sessions/${code}/end`, headers: auth(hostToken), payload: {} });
    expect(e1.json()).toEqual(e2.json());
    expect(e1.json()).toMatchObject({ code, scriptName: "APP-IRFD-DEMO", hostInstructions: 1, hostBreakdown: { ALT: 1 } });
    const play = await app.inject({ method: "POST", url: `/api/sessions/${code}/clock`, headers: auth(hostToken), payload: { action: "play" } });
    expect(play.statusCode).toBe(409);
    expect(play.json().error).toBe("Session has ended");
    const rep = await app.inject({ url: `/api/sessions/${code}/replay`, headers: auth(viewerToken) });
    expect(rep.headers["content-disposition"]).toBe(`attachment; filename="sweatbox-${code}.json"`);
    expect(rep.json()).toMatchObject({ format: "atc24academy-sweatbox-replay", version: 1, code });
    // archived: still available after the session is gone
    deps.sessions.remove(code);
    const arch = await app.inject({ url: `/api/sessions/${code}/replay`, headers: auth(viewerToken) });
    expect(arch.json().code).toBe(code);
  });

  it("rate limits host control", async () => {
    const h = await app.inject({ method: "POST", url: "/api/sessions", headers: auth(hostToken), payload: {} });
    const c = h.json().code;
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({ method: "POST", url: `/api/sessions/${c}/aircraft/00000000-0000-4000-8000-000000000000/air`, headers: auth(hostToken), payload: { alt: 1 } });
      statuses.push(r.statusCode);
    }
    expect(statuses).toContain(429);
  });
});

describe("routing helpers", () => {
  it("puts back an /api prefix stripped by a proxy", () => {
    expect(rewriteUrl("/sessions/AbCdEf")).toBe("/api/sessions/AbCdEf");
    expect(rewriteUrl("/me")).toBe("/api/me");
    expect(rewriteUrl("/auth/discord?next=/")).toBe("/api/auth/discord?next=/");
    expect(rewriteUrl("/auth/callback?code=1")).toBe("/auth/callback?code=1");
    expect(rewriteUrl("/api/me")).toBe("/api/me");
    expect(rewriteUrl("/s/AbCdEf")).toBe("/s/AbCdEf");
    expect(rewriteUrl("/maker")).toBe("/maker");
  });
});

describe("websocket", () => {
  it("joins a session, receives snapshots, and is closed with 4404 for unknown codes", async () => {
    const wsApp = await buildApp(deps);
    const ws = attachWebSocket(wsApp.server, deps);
    await wsApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (wsApp.server.address() as AddressInfo).port;
    const s = deps.sessions.create("dev-host-hosty");
    s.loadScript("T", "[sweatbox]\nairport = IRFD\nview = TWR\n[00:00] message: text=hi");
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${hostToken}`);
    const got: { t: string; cmds?: unknown[]; log?: { message: string }[]; clients?: unknown[] }[] = [];
    await new Promise<void>((res, rej) => {
      client.on("open", () => client.send(JSON.stringify({ t: "join", code: s.code })));
      client.on("message", (m) => {
        got.push(JSON.parse(m.toString()));
        if (got.length === 1) {
          s.play();
          deps.sessions.tickAll();
          deps.sessions.tickAll();
        }
        if (got.length >= 3) res();
      });
      client.on("error", rej);
    });
    expect(got[0]!.t).toBe("snapshot");
    expect(got[0]!.log!.some((l) => l.message.startsWith("Loaded script"))).toBe(true);
    expect(got[0]!.clients).toBeDefined(); // host
    expect(got.flatMap((g) => g.cmds ?? [])).toEqual([{ id: 1, text: "LDARPT IRFD TWR" }]);
    client.close();

    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${hostToken}`);
    const code = await new Promise<number>((res) => {
      bad.on("open", () => bad.send(JSON.stringify({ t: "join", code: "Zzzzzz" })));
      bad.on("close", (c) => res(c));
    });
    expect(code).toBe(4404);

    const anon = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    const anonCode = await new Promise<number>((res) => anon.on("close", (c) => res(c)));
    expect(anonCode).toBe(4401);
    ws.close();
    await wsApp.close();
  });
});
