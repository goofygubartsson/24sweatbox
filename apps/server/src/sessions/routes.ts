// Sessions, scenarios, clock, TWR, end, replay, host aircraft control and strips (spec 15.2-15.4).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "@sweatbox/config";
import {
  AirBody,
  ClockBody,
  CreateSessionBody,
  GeneratorError,
  GndBody,
  ScriptBody,
  SESSION_CODE_RE,
  StripBody,
  TwrBody,
  TwrToggleBody,
  generateSweatbox,
  type GenerateSpec,
} from "@sweatbox/shared";
import { HttpError, notFound, parseBody } from "../errors";
import { requireHost, requireUser, type Deps } from "../deps";
import type { Session } from "../sim/session";
import type { UserRow } from "../db";

const L = config.limits;

/** Airport + Position + Runway format -> script; impossible settings become 400 / 409 for the trainer. */
function generate(spec: GenerateSpec): { name: string; text: string } {
  try {
    return generateSweatbox({ apt: spec.apt, position: spec.position, runway: spec.runway, level: spec.level });
  } catch (e) {
    if (e instanceof GeneratorError) throw e.kind === "unavailable" ? new HttpError(409, "REJECTED", e.message) : new HttpError(400, "BAD_INPUT", e.message);
    throw e;
  }
}

export function sessionRoutes(app: FastifyInstance, deps: Deps): void {
  const { sessions, scenarios, limiter, store } = deps;

  const sessionOr404 = (req: FastifyRequest): Session => {
    const code = (req.params as { code: string }).code;
    const s = SESSION_CODE_RE.test(code) ? sessions.get(code) : undefined;
    if (!s) throw notFound("NO_SESSION", "No session with that code");
    return s;
  };

  /** Mark a REST poller / host as present in the session. */
  const present = (s: Session, u: UserRow) => {
    const now = Date.now();
    const prev = s.clients.get(u.id);
    s.clients.set(u.id, { userId: u.id, name: u.display_name, user: u.username, host: Boolean(u.is_host), firstSeen: prev?.firstSeen ?? now, lastSeen: now });
    s.touch();
  };

  // Create Sweatbox: optionally generate and load the sweatbox in the same step
  app.post("/api/sessions", async (req, reply) => {
    const u = await requireHost(req, deps);
    const body = parseBody(CreateSessionBody, req.body ?? {});
    const gen = body.generate ? generate(body.generate) : null;
    limiter.hit(`create:${u.id}`, L.sessionCreatePerMin / 60, L.sessionCreatePerMin);
    const s = sessions.create(u.id);
    present(s, u);
    if (!gen) return reply.code(201).send({ code: s.code });
    const r = s.loadScript(gen.name, gen.text);
    if (!r.ok) {
      sessions.remove(s.code);
      throw new HttpError(500, "SERVER_ERROR", "The generated sweatbox didn't load");
    }
    return reply.code(201).send({ code: s.code, scriptName: gen.name, commandCount: r.commandCount });
  });

  app.get("/api/sessions/:code", async (req) => {
    await requireUser(req, deps);
    return sessionOr404(req).info();
  });

  app.get("/api/sessions/:code/state", async (req) => {
    const u = await requireUser(req, deps);
    const s = sessionOr404(req);
    present(s, u);
    const q = req.query as Record<string, string | undefined>;
    const since = Number(q.since ?? 0) || 0;
    const cmdSince = q.cmdSince === undefined ? s.cmdSeq : Number(q.cmdSince) || 0;
    return s.snapshotFor({ host: Boolean(u.is_host), lastLogSeq: since, lastCmdId: cmdSince });
  });

  app.get("/api/scenarios", async (req) => {
    await requireHost(req, deps);
    return scenarios.list();
  });

  app.get("/api/scenarios/:name", async (req, reply) => {
    await requireHost(req, deps);
    const text = scenarios.read((req.params as { name: string }).name);
    if (text === null) throw notFound("NO_SCENARIO", "No scenario with that name");
    return reply.type("text/plain; charset=utf-8").send(text);
  });

  app.post("/api/sessions/:code/script", async (req) => {
    const u = await requireHost(req, deps);
    const s = sessionOr404(req);
    const body = parseBody(ScriptBody, req.body);
    let name: string;
    let text: string;
    if ("generate" in body) {
      ({ name, text } = generate(body.generate));
    } else if ("name" in body) {
      const t = scenarios.read(body.name);
      if (t === null) throw notFound("NO_SCENARIO", `No scenario called ${body.name}`);
      name = body.name;
      text = t;
    } else {
      if (Buffer.byteLength(body.text, "utf8") > config.session.maxScriptBytes)
        throw new HttpError(400, "BAD_INPUT", `Script is larger than ${config.session.maxScriptBytes} bytes`);
      name = body.label?.trim() || "Custom Sweatbox";
      text = body.text;
    }
    if (s.ended) throw new HttpError(409, "REJECTED", "Session has ended");
    const r = s.loadScript(name, text);
    if (!r.ok) throw new HttpError(422, "SCRIPT_ERRORS", `The script has ${r.errors.length} error(s)`, { errors: r.errors });
    present(s, u);
    return { commandCount: r.commandCount, scriptName: name };
  });

  app.post("/api/sessions/:code/clock", async (req) => {
    const u = await requireHost(req, deps);
    const s = sessionOr404(req);
    const body = parseBody(ClockBody, req.body);
    if ("action" in body) {
      if (body.action === "play") s.play();
      else s.pause();
    } else s.setSpeed(body.speed);
    present(s, u);
    return { running: s.running, speed: s.speed };
  });

  app.post("/api/sessions/:code/twr", async (req) => {
    const u = await requireHost(req, deps);
    const s = sessionOr404(req);
    const body = parseBody(TwrToggleBody, req.body);
    s.setTwr(body.on);
    present(s, u);
    return { twr: s.twrMode };
  });

  app.post("/api/sessions/:code/end", async (req) => {
    await requireHost(req, deps);
    return sessions.end(sessionOr404(req));
  });

  app.get("/api/sessions/:code/replay", async (req, reply) => {
    await requireUser(req, deps);
    const code = (req.params as { code: string }).code;
    if (!SESSION_CODE_RE.test(code)) throw notFound("NO_SESSION", "No session with that code");
    const live = sessions.get(code);
    const json = live ? JSON.stringify(live.replay()) : store.getReplay(code);
    if (!json) throw notFound("NO_SESSION", "No replay for that code (it may have expired)");
    return reply
      .type("application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="sweatbox-${code}.json"`)
      .send(json);
  });

  for (const kind of ["air", "gnd", "twr"] as const) {
    const schema = kind === "air" ? AirBody : kind === "gnd" ? GndBody : TwrBody;
    app.post(`/api/sessions/:code/aircraft/:id/${kind}`, async (req) => {
      const u = await requireHost(req, deps);
      limiter.hit(`host:${u.id}`, L.hostControlPerSec);
      const s = sessionOr404(req);
      s.aircraftOr404((req.params as { id: string }).id);
      const body = parseBody(schema, req.body);
      if (s.ended) throw new HttpError(409, "REJECTED", "Session has ended");
      present(s, u);
      return { ok: true, aircraft: s.hostControl(kind, (req.params as { id: string }).id, body) };
    });
  }

  app.post("/api/sessions/:code/strips", async (req, reply) => {
    const u = await requireUser(req, deps);
    limiter.hit(`strips:${u.id}`, L.stripsPerSec);
    const s = sessionOr404(req);
    const body = parseBody(StripBody, req.body);
    s.setStrip(body.callsign, body.key, body.value);
    present(s, u);
    return reply.code(204).send();
  });
}
