import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "@sweatbox/config";
import type { Store, UserRow } from "./db";
import type { Env } from "./env";
import type { Secrets } from "./crypto";
import type { AuthService } from "./auth/service";
import type { DiscordClient } from "./auth/discord";
import type { SessionManager } from "./sessions/manager";
import type { ScenarioLibrary } from "./sessions/scenarios";
import type { RateLimiter } from "./rateLimit";
import { HttpError } from "./errors";

export interface Deps {
  env: Env;
  store: Store;
  secrets: Secrets;
  discord: DiscordClient;
  auth: AuthService;
  sessions: SessionManager;
  scenarios: ScenarioLibrary;
  limiter: RateLimiter;
}

/** Session token from the sb_session cookie or an Authorization: Bearer header. */
export function tokenFrom(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return req.cookies?.[config.auth.cookieName] ?? null;
}

export async function currentUser(req: FastifyRequest, deps: Deps, force = false): Promise<UserRow | null> {
  const u = deps.auth.userForToken(tokenFrom(req)) ?? deps.auth.fakeUser();
  return u ? deps.auth.ensureFresh(u, force) : null;
}

export async function requireUser(req: FastifyRequest, deps: Deps): Promise<UserRow> {
  const u = await currentUser(req, deps);
  if (!u) throw new HttpError(401, "NOT_LOGGED_IN", "Log in with Discord first");
  if (!u.in_guild) throw new HttpError(403, "NOT_IN_GUILD", "Join the ATC24Academy Discord first");
  return u;
}

export async function requireHost(req: FastifyRequest, deps: Deps): Promise<UserRow> {
  const u = await requireUser(req, deps);
  if (!u.is_host) throw new HttpError(403, "NOT_HOST", u.reauth ? "Log in again to host" : "Only hosts can do that");
  return u;
}

export function setSessionCookie(reply: FastifyReply, token: string, env: Env): void {
  reply.setCookie(config.auth.cookieName, token, {
    httpOnly: true,
    secure: !env.isDev,
    sameSite: "lax",
    path: "/",
    maxAge: config.auth.cookieMaxAgeDays * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply, env: Env): void {
  reply.clearCookie(config.auth.cookieName, { path: "/", httpOnly: true, secure: !env.isDev, sameSite: "lax" });
}
