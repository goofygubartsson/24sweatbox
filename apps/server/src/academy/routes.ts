// ATC24Academy routes. /api/v1/* is the academy's server-to-server API (API key, errors as
// { error: { message } }); /api/academy/* is the web side for students and hosts (Discord login).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { config } from "@sweatbox/config";
import { AcademyCompleteBody, AcademyLaunchBody } from "@sweatbox/shared";
import { HttpError, parseBody } from "../errors";
import { requireHost, requireUser, type Deps } from "../deps";
import { apiKeyMatches } from "./signing";
import { CancelBody, LaunchTokenBody, ReserveBody } from "./service";

const API = config.app.apiBase;
const A = config.academy;

/** 422 with the first problem, in the academy's error format. */
function parseAcademy<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const res = schema.safeParse(body ?? {});
  if (!res.success) {
    const first = res.error.issues[0]!;
    throw new HttpError(422, "BAD_INPUT", first.path.length ? `${first.path.join(".")}: ${first.message}` : first.message);
  }
  return res.data;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export async function academyRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { academy, limiter } = deps;

  // ---- the academy's API -------------------------------------------------------------------------------
  await app.register(
    async (v1) => {
      v1.setErrorHandler((err: Error & { statusCode?: number }, req, reply: FastifyReply) => {
        const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
        if (status >= 500 && !(err instanceof HttpError)) req.log.error(err);
        const message =
          err instanceof HttpError
            ? err.message
            : status === 413
              ? "Request body is too large"
              : status < 500
                ? err.message
                : "Something went wrong on the sweatbox; try again";
        if (status === 429) reply.header("Retry-After", "60");
        return reply.code(status).send({ error: { message } });
      });
      v1.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { message: "Not found" } }));

      v1.addHook("onRequest", async (req) => {
        limiter.hit(`academy-api:${req.ip}`, A.requestsPerMin / 60, Math.min(30, A.requestsPerMin));
        if (!academy.enabled) throw new HttpError(503, "FEATURE_DISABLED", "The ATC24Academy integration isn't configured on this sweatbox");
        const auth = header(req, "authorization") ?? "";
        const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!key || !apiKeyMatches(key, deps.env.academyKeyHashes)) throw new HttpError(401, "NOT_LOGGED_IN", "Missing or invalid API key");
      });

      const opts = { bodyLimit: 128 * 1024 };

      v1.post("/sessions", opts, async (req, reply) => {
        const body = parseAcademy(ReserveBody, req.body);
        const r = await academy.reserve(body, header(req, "idempotency-key"));
        return reply.code(r.created ? 201 : 200).send(r.response);
      });

      v1.post("/sessions/:id/cancel", opts, async (req) => {
        const body = parseAcademy(CancelBody, req.body);
        return academy.cancel((req.params as { id: string }).id, body.reason, header(req, "idempotency-key"));
      });

      v1.post("/sessions/:id/launch-tokens", opts, async (req) => {
        const body = parseAcademy(LaunchTokenBody, req.body);
        return academy.launchToken((req.params as { id: string }).id, body.studentDiscordId);
      });
    },
    { prefix: `${API}/v1` },
  );

  // ---- students and hosts ------------------------------------------------------------------------------
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.post(`${API}/academy/launch`, async (req) => {
    const u = await requireUser(req, deps);
    limiter.hit(`academy-launch:${u.id}`, A.launchesPerMin / 60, Math.min(10, A.launchesPerMin));
    const body = parseBody(AcademyLaunchBody, req.body);
    return { view: academy.launch(body.token, u) };
  });

  app.get(`${API}/academy/sessions`, async (req) => {
    const u = await requireHost(req, deps);
    return academy.hosting(u);
  });

  app.get(`${API}/academy/sessions/:id`, async (req) => {
    const u = await requireUser(req, deps);
    return academy.viewFor(id(req), u);
  });

  app.post(`${API}/academy/sessions/:id/start`, async (req, reply) => {
    const u = await requireHost(req, deps);
    limiter.hit(`create:${u.id}`, config.limits.sessionCreatePerMin / 60, config.limits.sessionCreatePerMin);
    return reply.code(201).send(academy.start(id(req), u));
  });

  app.post(`${API}/academy/sessions/:id/complete`, async (req) => {
    const u = await requireHost(req, deps);
    const body = parseBody(AcademyCompleteBody, req.body);
    return academy.complete(id(req), u, body);
  });
}
