// ATC24Academy integration: the academy's API, launch links, results and the callback outbox.
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@sweatbox/config";
import { loadEnv, repoRoot } from "../src/env";
import { Store } from "../src/db";
import { Secrets, sha256 } from "../src/crypto";
import { DiscordClient } from "../src/auth/discord";
import { AuthService } from "../src/auth/service";
import { SessionManager } from "../src/sessions/manager";
import { ScenarioLibrary } from "../src/sessions/scenarios";
import { RateLimiter } from "../src/rateLimit";
import { buildApp } from "../src/app";
import type { Deps } from "../src/deps";
import { AcademyService } from "../src/academy/service";
import { AcademyStore, type AcademySessionRow } from "../src/academy/store";
import { CallbackOutbox, retryDelaySec } from "../src/academy/outbox";
import type { HostInviter, InviteResult } from "../src/academy/invite";
import { apiKeyMatches, signCallback } from "../src/academy/signing";

const API_KEY = "a".repeat(64);
const SECRET = "webhook-secret-webhook-secret-0123456789";
const ACADEMY = "https://atc24academy.com";
const STUDENT = "123456789012345678";
const HOST = "234567890123456789";
const OTHER = "345678901234567890";

/** An inviter whose next answers the test decides. */
class FakeInviter implements HostInviter {
  calls: { id: string; kind: "invite" | "cancel" }[] = [];
  next: InviteResult[] = [];
  async notify(s: AcademySessionRow, kind: "invite" | "cancel"): Promise<InviteResult> {
    this.calls.push({ id: s.id, kind });
    return this.next.shift() ?? { ok: true };
  }
}

/** The academy's callback endpoint: records each request and answers from a queue. */
const received: { url: string; headers: Record<string, string>; body: string }[] = [];
let answers: (number | "network")[] = [];
const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  received.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
  const a = answers.shift() ?? 200;
  if (a === "network") throw new TypeError("fetch failed");
  return new Response(JSON.stringify(a === 200 ? { status: "processed" } : { error: "x" }), { status: a });
};

/** Rate limits apply to one test address only (every injected request shares 127.0.0.1). */
const LIMITED_IP = "203.0.113.9";
function limitedFor(ip: string): RateLimiter {
  const real = new RateLimiter();
  return { hit: (key: string, perSec: number, burst?: number) => (key.endsWith(`:${ip}`) ? real.hit(key, perSec, burst) : undefined) } as unknown as RateLimiter;
}

let app: FastifyInstance;
let deps: Deps;
let inviter: FakeInviter;
let outbox: CallbackOutbox;
let clock = Date.now();
const alerts: string[] = [];
let tokens: Record<"student" | "host" | "other", string>;

const academyHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${API_KEY}`, "content-type": "application/json", accept: "application/json", ...extra });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

let refN = 0;
function booking(over: Record<string, unknown> = {}) {
  refN++;
  return {
    reference: `atc24-sb-test${refN}`,
    student: { id: "8b0c6c1e-2f4a-4b8e-9a51-0e6d1c2b3a40", discordId: STUDENT, username: "pilot" },
    course: { id: "1f6e2a9c-3b7d-4c8e-a1f2-3d4e5f6a7b8c", title: "Ground Control Fundamentals" },
    module: { id: "2a7f3b0d-4c8e-4d9f-b2a3-4e5f6a7b8c9d", title: "Ground practical assessment" },
    attempt: { id: "3b8a4c1e-5d9f-4eaf-83b4-5f6a7b8c9d0e", number: 1 },
    host: { discordId: HOST, name: "Instructor" },
    scheduledAt: "2026-11-02T18:00:00.000Z",
    assessmentType: "Practical assessment",
    instructions: "Control the ground position for 30 minutes",
    passingCriteria: "Safe, efficient routing",
    returnUrl: `${ACADEMY}/learn/ground-control-fundamentals/2a7f3b0d-4c8e-4d9f-b2a3-4e5f6a7b8c9d`,
    callbackUrl: `${ACADEMY}/api/integrations/sweatbox/callback`,
    ...over,
  };
}

async function reserve(body = booking(), key: string | null = body.reference as string) {
  return app.inject({ method: "POST", url: "/api/v1/sessions", headers: academyHeaders(key === null ? {} : { "idempotency-key": key }), payload: body });
}

const tokenOf = (launchUrl: string) => /\/join(?:\/|\?token=)([A-Za-z0-9_-]+)$/.exec(launchUrl)![1]!;
const launch = (token: string, who: keyof typeof tokens) =>
  app.inject({ method: "POST", url: "/api/academy/launch", headers: bearer(tokens[who]), payload: { token } });
const academyStore = () => deps.academy.store;
/** Run the outbox at the test clock (never behind real time: events are queued at Date.now()). */
const flush = () => {
  clock = Math.max(clock, Date.now());
  return outbox.runOnce();
};

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: "development",
    DEV_FAKE_USER: "",
    ACADEMY_BASE_URL: ACADEMY,
    ACADEMY_API_KEY_HASH: sha256(API_KEY),
    ACADEMY_WEBHOOK_SECRET: SECRET,
    ACADEMY_LAUNCH_TOKEN_TTL_SECONDS: "300",
  });
  env.NODE_ENV = "test";
  const store = new Store(":memory:");
  const secrets = new Secrets("test-secret-test-secret-test-secret-0123456789");
  const discord = new DiscordClient(env);
  const sessions = new SessionManager(store);
  inviter = new FakeInviter();
  outbox = new CallbackOutbox(new AcademyStore(store.db), {
    secret: SECRET,
    origin: env.academyOrigin,
    fetch: fakeFetch,
    now: () => clock,
    alert: (m) => alerts.push(m),
  });
  const auth = new AuthService(store, env, discord, secrets);
  deps = {
    env,
    store,
    secrets,
    discord,
    auth,
    sessions,
    scenarios: new ScenarioLibrary(path.resolve(repoRoot(), "data/scenarios")),
    limiter: limitedFor(LIMITED_IP),
    academy: new AcademyService(store, sessions, secrets, env, inviter, outbox),
  };
  app = await buildApp(deps);
  const user = (id: string, name: string, host: boolean) => {
    store.upsertUser({
      id,
      username: name,
      display_name: name,
      avatar: null,
      is_host: host ? 1 : 0,
      reauth: 0,
      in_guild: 1,
      roles_checked_at: Date.now() + 86_400_000, // no Discord re-check during the tests
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
    });
    return auth.createSession(id);
  };
  tokens = { student: user(STUDENT, "pilot", false), host: user(HOST, "instructor", true), other: user(OTHER, "someone", false) };
});

afterAll(async () => {
  await app.close();
  deps.store.close();
});

beforeEach(() => {
  inviter.calls = [];
  inviter.next = [];
  received.length = 0;
  answers = [];
  alerts.length = 0;
  clock = Date.now();
  // callbacks queued by earlier tests are not this test's business
  deps.store.db.prepare("UPDATE academy_outbox SET status = 'delivered' WHERE status = 'pending'").run();
});

describe("POST /v1/sessions", () => {
  it("reserves a session and returns the contract's fields", async () => {
    const r = await reserve();
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.sessionId).toMatch(/^sb_[A-Za-z0-9_-]+$/);
    expect(j.sessionId.length).toBeLessThanOrEqual(200);
    expect(j.launchUrl).toMatch(new RegExp(`^${config.app.publicUrl}/join/[A-Za-z0-9_-]{43}$`));
    expect(j.status).toBe("reserved");
    expect(j.hostInvite).toEqual({ status: "sent" });
    expect(inviter.calls).toEqual([{ id: j.sessionId, kind: "invite" }]);
    const row = academyStore().getSession(j.sessionId)!;
    expect(row).toMatchObject({ student_discord_id: STUDENT, host_discord_id: HOST, attempt_id: "3b8a4c1e-5d9f-4eaf-83b4-5f6a7b8c9d0e" });
    // only the hash of the launch token is stored in clear
    expect(JSON.stringify(row)).not.toContain(tokenOf(j.launchUrl));
  });

  it("returns the same session for a repeated Idempotency-Key and never makes a second one", async () => {
    const body = booking();
    const a = await reserve(body);
    const b = await reserve(body);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().sessionId).toBe(a.json().sessionId);
    expect(b.json().launchUrl).toBe(a.json().launchUrl);
    const n = deps.store.db.prepare("SELECT COUNT(*) AS n FROM academy_sessions WHERE reference = ?").get(body.reference) as { n: number };
    expect(n.n).toBe(1);
    expect(inviter.calls).toHaveLength(1); // the invite was sent; a retry doesn't send it again
  });

  it("409s the same key with a different body", async () => {
    const body = booking();
    await reserve(body);
    const r = await reserve({ ...body, scheduledAt: "2026-11-03T18:00:00.000Z" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { message: expect.any(String) } });
  });

  it("401s a missing or wrong API key", async () => {
    const body = booking();
    const none = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "idempotency-key": body.reference }, payload: body });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { message: "Missing or invalid API key" } });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { ...academyHeaders({ "idempotency-key": body.reference }), authorization: `Bearer ${"b".repeat(64)}` },
      payload: body,
    });
    expect(wrong.statusCode).toBe(401);
    expect(apiKeyMatches(API_KEY, deps.env.academyKeyHashes)).toBe(true);
  });

  it("rejects a callbackUrl (or returnUrl) outside the academy origin", async () => {
    const r = await reserve(booking({ callbackUrl: "https://evil.example/api/integrations/sweatbox/callback" }));
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/callbackUrl/);
    expect((await reserve(booking({ callbackUrl: "http://atc24academy.com/api/integrations/sweatbox/callback" }))).statusCode).toBe(422);
    expect((await reserve(booking({ returnUrl: "https://evil.example/" }))).statusCode).toBe(422);
  });

  it("validates the body and the Idempotency-Key", async () => {
    const body = booking();
    expect((await reserve(body, null)).statusCode).toBe(400);
    expect((await reserve(body, "something-else")).statusCode).toBe(422);
    const numeric = await reserve(booking({ student: { ...body.student, discordId: 123456789012345680 } }));
    expect(numeric.statusCode).toBe(422);
    expect(numeric.json().error.message).toMatch(/student\.discordId/);
    expect((await reserve(booking({ attempt: { id: "not-a-uuid", number: 1 } }))).statusCode).toBe(422);
    expect((await reserve(booking({ scheduledAt: "tomorrow" }))).statusCode).toBe(422);
    // nullable fields
    expect((await reserve(booking({ host: { discordId: HOST, name: null }, assessmentType: null }))).statusCode).toBe(201);
  });

  it("reports a failed host invite with its reason and re-invites on a retry", async () => {
    inviter.next = [{ ok: false, error: "The host doesn't accept direct messages from the ATC24Academy server" }];
    const body = booking();
    const a = await reserve(body);
    expect(a.statusCode).toBe(201);
    expect(a.json().hostInvite).toEqual({ status: "failed", error: "The host doesn't accept direct messages from the ATC24Academy server" });
    const b = await reserve(body);
    expect(b.statusCode).toBe(200);
    expect(b.json().hostInvite).toEqual({ status: "sent" });
    expect(inviter.calls.map((c) => c.kind)).toEqual(["invite", "invite"]);
    expect(academyStore().auditFor(a.json().sessionId).map((e) => e.action)).toEqual(["created", "host_invite_failed", "host_invited"]);
  });
});

describe("POST /v1/sessions/:id/cancel", () => {
  it("is idempotent and invalidates the launch links", async () => {
    const r = (await reserve()).json();
    const ref = academyStore().getSession(r.sessionId)!.reference;
    const tok = (
      await app.inject({ method: "POST", url: `/api/v1/sessions/${r.sessionId}/launch-tokens`, headers: academyHeaders(), payload: { studentDiscordId: STUDENT } })
    ).json();
    const cancel = () =>
      app.inject({ method: "POST", url: `/api/v1/sessions/${r.sessionId}/cancel`, headers: academyHeaders({ "idempotency-key": `${ref}:cancel` }), payload: { reason: "Host unavailable" } });
    const a = await cancel();
    const b = await cancel();
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ ok: true });
    expect(inviter.calls.filter((c) => c.kind === "cancel")).toHaveLength(1); // the host is told once
    expect(academyStore().auditFor(r.sessionId).filter((e) => e.action === "cancelled")).toHaveLength(1);
    for (const url of [r.launchUrl, tok.launchUrl]) {
      const l = await launch(tokenOf(url), "student");
      expect(l.statusCode).toBe(410);
      expect(l.json()).toMatchObject({ code: "LINK_CLOSED", returnUrl: expect.stringMatching(/^https:\/\/atc24academy\.com\/learn\//) });
    }
    const t = await app.inject({ method: "POST", url: `/api/v1/sessions/${r.sessionId}/launch-tokens`, headers: academyHeaders(), payload: { studentDiscordId: STUDENT } });
    expect(t.statusCode).toBe(409);
  });

  it("allows an empty reason and 404s unknown sessions", async () => {
    const r = (await reserve()).json();
    const ok = await app.inject({ method: "POST", url: `/api/v1/sessions/${r.sessionId}/cancel`, headers: academyHeaders(), payload: { reason: "" } });
    expect(ok.statusCode).toBe(200);
    const nf = await app.inject({ method: "POST", url: "/api/v1/sessions/sb_doesnotexist000/cancel", headers: academyHeaders(), payload: { reason: "" } });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: { message: expect.any(String) } });
  });
});

describe("launch links", () => {
  const issue = (id: string, student = STUDENT) =>
    app.inject({ method: "POST", url: `/api/v1/sessions/${id}/launch-tokens`, headers: academyHeaders(), payload: { studentDiscordId: student } });

  it("one-time tokens: short-lived, single use, bound to the student", async () => {
    const r = (await reserve()).json();
    const t = await issue(r.sessionId);
    expect(t.statusCode).toBe(200);
    const { launchUrl, expiresAt } = t.json();
    expect(launchUrl).toMatch(new RegExp(`^${config.app.publicUrl}/join\\?token=[A-Za-z0-9_-]{43}$`));
    const ttl = Date.parse(expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
    const token = tokenOf(launchUrl);
    // another account can't use it (and doesn't burn it)
    expect((await launch(token, "other")).statusCode).toBe(403);
    const ok = await launch(token, "student");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().view).toMatchObject({ id: r.sessionId, status: "reserved", liveCode: null, course: "Ground Control Fundamentals" });
    expect(ok.json().view.inviteStatus).toBeUndefined(); // host-only fields stay with the hosts
    expect((await launch(token, "student")).statusCode).toBe(410);
  });

  it("rejects expired tokens and a mismatched student", async () => {
    const r = (await reserve()).json();
    expect((await issue(r.sessionId, OTHER)).statusCode).toBe(403);
    const token = tokenOf((await issue(r.sessionId)).json().launchUrl);
    deps.store.db.prepare("UPDATE academy_launch_tokens SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1, sha256(token));
    const l = await launch(token, "student");
    expect(l.statusCode).toBe(410);
    expect(l.json().error).toMatch(/expired/);
    expect((await launch("x".repeat(43), "student")).statusCode).toBe(404);
  });

  it("the session link admits only its student, who then (and only then) can join the live session", async () => {
    const r = (await reserve()).json();
    const start = await app.inject({ method: "POST", url: `/api/academy/sessions/${r.sessionId}/start`, headers: bearer(tokens.host) });
    expect(start.statusCode).toBe(201);
    const code = start.json().code as string;
    const peek = (who: keyof typeof tokens) => app.inject({ url: `/api/sessions/${code}`, headers: bearer(tokens[who]) });
    expect((await peek("student")).statusCode).toBe(404); // not launched yet
    expect((await peek("other")).statusCode).toBe(404);
    expect((await peek("host")).json()).toMatchObject({ code, academyId: r.sessionId });
    expect((await launch(tokenOf(r.launchUrl), "other")).statusCode).toBe(403);
    const ok = await launch(tokenOf(r.launchUrl), "student");
    expect(ok.json().view.liveCode).toBe(code);
    expect((await peek("student")).statusCode).toBe(200);
    expect((await peek("other")).statusCode).toBe(404);
    // the session link keeps working until the session ends
    expect((await launch(tokenOf(r.launchUrl), "student")).statusCode).toBe(200);
  });
});

describe("results", () => {
  async function bookAndRun() {
    const r = (await reserve()).json();
    const code = (await app.inject({ method: "POST", url: `/api/academy/sessions/${r.sessionId}/start`, headers: bearer(tokens.host) })).json().code as string;
    await launch(tokenOf(r.launchUrl), "student");
    return { ...r, code };
  }
  const complete = (id: string, payload: Record<string, unknown>, who: keyof typeof tokens = "host") =>
    app.inject({ method: "POST", url: `/api/academy/sessions/${id}/complete`, headers: bearer(tokens[who]), payload });

  it("the host's result ends the session and sends exactly one signed session.completed", async () => {
    const r = await bookAndRun();
    expect((await app.inject({ method: "POST", url: `/api/sessions/${r.code}/end`, headers: bearer(tokens.host) })).statusCode).toBe(409);
    expect((await complete(r.sessionId, { outcome: "pass" }, "student")).statusCode).toBe(403);
    const c = await complete(r.sessionId, { outcome: "pass", score: 92, feedback: "Clear phraseology; watch hold-short readbacks." });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ status: "completed", outcome: "pass", resultDelivery: "pending" });
    expect(deps.sessions.get(r.code)!.ended).toBe(true);
    expect((await complete(r.sessionId, { outcome: "fail" })).statusCode).toBe(409);
    // the links die with the session
    expect((await launch(tokenOf(r.launchUrl), "student")).statusCode).toBe(410);

    await flush();
    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.url).toBe(`${ACADEMY}/api/integrations/sweatbox/callback`);
    expect(req.headers["X-Sweatbox-Signature"]).toBe(signCallback(SECRET, req.headers["X-Sweatbox-Timestamp"]!, req.body));
    expect(req.headers["X-Sweatbox-Timestamp"]).toBe(String(Math.floor(clock / 1000)));
    const ev = JSON.parse(req.body);
    const row = academyStore().getSession(r.sessionId)!;
    expect(ev).toEqual({
      eventId: expect.stringMatching(/^evt_[A-Za-z0-9_-]{8,190}$/),
      type: "session.completed",
      sessionReference: row.reference,
      sweatboxSessionId: r.sessionId,
      studentId: row.student_id,
      studentDiscordId: STUDENT,
      courseId: row.course_id,
      moduleId: row.module_id,
      attemptId: row.attempt_id,
      outcome: "pass",
      completedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      score: 92,
      feedback: "Clear phraseology; watch hold-short readbacks.",
      replayUrl: `${config.app.publicUrl}/replay?code=${r.code}`,
    });
    expect(academyStore().eventsFor(r.sessionId).map((e) => [e.type, e.status])).toEqual([["session.completed", "delivered"]]);
    // the replay belongs to the student and the hosts
    expect((await app.inject({ url: `/api/sessions/${r.code}/replay`, headers: bearer(tokens.student) })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/sessions/${r.code}/replay`, headers: bearer(tokens.other) })).statusCode).toBe(404);
  });

  it("never sends session.completed for a cancelled session", async () => {
    const r = await bookAndRun();
    await app.inject({ method: "POST", url: `/api/v1/sessions/${r.sessionId}/cancel`, headers: academyHeaders(), payload: { reason: "" } });
    expect(deps.sessions.get(r.code)!.ended).toBe(true);
    expect((await complete(r.sessionId, { outcome: "pass" })).statusCode).toBe(409);
    await flush();
    expect(received).toHaveLength(0);
    expect(academyStore().eventsFor(r.sessionId)).toHaveLength(0);
  });

  it("a completed session can't be cancelled afterwards", async () => {
    const r = await bookAndRun();
    await complete(r.sessionId, { outcome: "fail", score: null, feedback: null });
    const c = await app.inject({ method: "POST", url: `/api/v1/sessions/${r.sessionId}/cancel`, headers: academyHeaders(), payload: { reason: "" } });
    expect(c.statusCode).toBe(409);
    await flush();
    expect(JSON.parse(received[0]!.body)).toMatchObject({ outcome: "fail", score: null, feedback: null });
  });

  it("a session that was never started still gets its result, without a replay", async () => {
    const r = (await reserve()).json();
    expect((await complete(r.sessionId, { outcome: "fail" })).statusCode).toBe(200);
    await flush();
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ type: "session.completed", replayUrl: null });
  });
});

describe("callback outbox", () => {
  async function completedEvent() {
    const r = (await reserve()).json();
    await app.inject({ method: "POST", url: `/api/academy/sessions/${r.sessionId}/complete`, headers: bearer(tokens.host), payload: { outcome: "pass" } });
    return academyStore().eventsFor(r.sessionId)[0]!;
  }

  it("signs like the reference implementation", () => {
    expect(signCallback("test-secret", "1700000000", '{"a":1}')).toBe("sha256=8cb2c3355fca388e9ac2caec004f4d5d7045d74937ab5faad61dc11682247a9f");
  });

  it("retries 5xx, 429 and network errors with backoff, keeping the eventId and body", async () => {
    const ev = await completedEvent();
    answers = [503, "network", 429, 200];
    for (let i = 0; i < 4; i++) {
      await flush();
      const row = academyStore().getEvent(ev.event_id)!;
      if (i < 3) {
        expect(row).toMatchObject({ status: "pending", attempts: i + 1 });
        expect(row.next_attempt_at - clock).toBe(retryDelaySec(i + 1) * 1000);
        await flush(); // not due yet: nothing is sent
        expect(received).toHaveLength(i + 1);
        clock = row.next_attempt_at;
      } else expect(row).toMatchObject({ status: "delivered", attempts: 4 });
    }
    expect(retryDelaySec(1)).toBe(30);
    expect(retryDelaySec(20)).toBe(3600);
    expect(new Set(received.map((r) => r.body)).size).toBe(1);
    expect(new Set(received.map((r) => JSON.parse(r.body).eventId))).toEqual(new Set([ev.event_id]));
    // a new timestamp and signature on every attempt
    expect(new Set(received.map((r) => r.headers["X-Sweatbox-Timestamp"])).size).toBe(4);
    for (const r of received) expect(r.headers["X-Sweatbox-Signature"]).toBe(signCallback(SECRET, r.headers["X-Sweatbox-Timestamp"]!, r.body));
  });

  it("stops (and alerts staff) on 401 and 422", async () => {
    for (const code of [401, 422, 400, 413]) {
      const ev = await completedEvent();
      answers = [code];
      received.length = 0;
      await flush();
      clock += 86_400_000;
      await flush();
      expect(received).toHaveLength(1);
      expect(academyStore().getEvent(ev.event_id)).toMatchObject({ status: "failed", attempts: 1, last_status: code });
      clock = Date.now();
    }
    expect(alerts).toHaveLength(4);
    expect(alerts[0]).toMatch(/ACADEMY_WEBHOOK_SECRET/);
  });

  it("gives up after the retry window and flags it", async () => {
    const ev = await completedEvent();
    clock = ev.created_at + config.academy.retryForHours * 3_600_000;
    answers = [500];
    await flush();
    expect(academyStore().getEvent(ev.event_id)).toMatchObject({ status: "failed" });
    expect(alerts[0]).toMatch(/gave up/);
  });
});

describe("web side", () => {
  it("lists the host's bookings and hides them from others", async () => {
    const r = (await reserve()).json();
    const list = await app.inject({ url: "/api/academy/sessions", headers: bearer(tokens.host) });
    expect(list.statusCode).toBe(200);
    expect(list.json().find((v: { id: string }) => v.id === r.sessionId)).toMatchObject({ inviteStatus: "sent", hostDiscordId: HOST });
    expect((await app.inject({ url: "/api/academy/sessions", headers: bearer(tokens.student) })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/academy/sessions/${r.sessionId}`, headers: bearer(tokens.other) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/academy/sessions/${r.sessionId}`, headers: bearer(tokens.student) })).statusCode).toBe(404); // not launched yet
  });

  it("rate-limits the academy API per client", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 35; i++)
      codes.push((await app.inject({ method: "POST", url: "/api/v1/sessions/sb_doesnotexist000/cancel", headers: academyHeaders(), payload: {}, remoteAddress: LIMITED_IP })).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("academy API errors use { error: { message } }, and it is off without ACADEMY_BASE_URL", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { ...academyHeaders({ "idempotency-key": "x" }) }, payload: "{bad json" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: { message: expect.any(String) } });
    expect(loadEnv({ ACADEMY_BASE_URL: "", NODE_ENV: "development" }).academyOrigin).toBeNull();
    expect(() => loadEnv({ ACADEMY_BASE_URL: "http://atc24academy.com", NODE_ENV: "production", ACADEMY_API_KEY_HASH: sha256(API_KEY), ACADEMY_WEBHOOK_SECRET: SECRET, DISCORD_CLIENT_ID: "x", DISCORD_CLIENT_SECRET: "x", DISCORD_REDIRECT_URI: "x", SESSION_SIGNING_SECRET: "x".repeat(40), DEV_FAKE_USER: "" })).toThrow(/https/);
  });
});
