// /api/auth/*, /auth/callback and /api/me (spec 15.1).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@sweatbox/config";
import { DevLoginBody } from "@sweatbox/shared";
import { randomToken } from "../crypto";
import { parseBody, HttpError } from "../errors";
import { clearSessionCookie, requireUser, setSessionCookie, tokenFrom, type Deps } from "../deps";

const OAUTH_COOKIE = "sb_oauth";

/** Only same-site relative paths ("/s/AbCdEf"), never "//evil.example" or absolute URLs. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && /^\/(?![/\\])[\w\-./?=&%#]*$/.test(next) ? next : "/";
}

function redirectUri(req: FastifyRequest, deps: Deps): string {
  if (deps.env.DISCORD_REDIRECT_URI) return deps.env.DISCORD_REDIRECT_URI;
  // development without a configured redirect: http://localhost:<port>/auth/callback
  return `${req.protocol}://${req.headers.host ?? "localhost"}${config.app.authCallbackPath}`;
}

export function authRoutes(app: FastifyInstance, deps: Deps): void {
  const { env, auth, discord, secrets } = deps;

  app.get("/api/auth/discord", async (req, reply) => {
    const next = safeNext((req.query as Record<string, unknown>).next);
    const fake = auth.fakeUser();
    if (fake) {
      // DEV_FAKE_USER: no Discord round trip
      setSessionCookie(reply, auth.createSession(fake.id), env);
      return reply.redirect(next);
    }
    if (!discord.configured) return reply.redirect("/?login_error=discord_error");
    const nonce = randomToken(16);
    const state = secrets.sign(JSON.stringify({ n: nonce, next, t: Date.now() }));
    reply.setCookie(OAUTH_COOKIE, nonce, {
      httpOnly: true,
      secure: !env.isDev,
      sameSite: "lax",
      path: "/",
      maxAge: config.auth.stateMaxAgeSec,
    });
    return reply.redirect(discord.authorizeUrl(state, redirectUri(req, deps)));
  });

  const callback = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    const fail = (why: "not_in_guild" | "discord_error" | "bad_state") => reply.redirect(`/?login_error=${why}`);
    const payload = q.state ? secrets.verify(q.state) : null;
    let state: { n?: string; next?: string; t?: number } = {};
    try {
      state = payload ? (JSON.parse(payload) as typeof state) : {};
    } catch {
      state = {};
    }
    const nonce = req.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: "/" });
    if (!payload || !state.n || state.n !== nonce || Date.now() - (state.t ?? 0) > config.auth.stateMaxAgeSec * 1000) return fail("bad_state");
    if (q.error || !q.code) return fail("discord_error");
    const r = await auth.completeLogin(q.code, redirectUri(req, deps));
    if (!r.ok) return fail(r.reason);
    // rotate: the previous session (if any) is dropped
    auth.logout(tokenFrom(req));
    setSessionCookie(reply, r.token, env);
    return reply.redirect(safeNext(state.next));
  };
  app.get(config.app.authCallbackPath, callback);
  app.get("/api/auth/callback", callback);

  app.post("/api/auth/logout", async (req, reply) => {
    auth.logout(tokenFrom(req));
    clearSessionCookie(reply, env);
    return reply.code(204).send();
  });

  app.get("/api/me", async (req) => {
    const u = await requireUser(req, deps);
    // session restore: always re-check the role when it is stale
    return auth.toMe(await auth.ensureFresh(u));
  });

  app.post("/api/auth/dev-login", async (req, reply) => {
    if (!env.isDev) throw new HttpError(404, "BAD_INPUT", "Not found");
    const body = parseBody(DevLoginBody, req.body);
    const u = auth.devUser(body.as, body.name);
    auth.logout(tokenFrom(req));
    const token = auth.createSession(u.id);
    setSessionCookie(reply, token, env);
    return { ...auth.toMe(u), token };
  });
}
