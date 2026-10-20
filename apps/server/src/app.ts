// Fastify application: CORS, error format, routes, optional static web app.
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { config } from "@sweatbox/config";
import { HttpError } from "./errors";
import { repoRoot } from "./env";
import type { Deps } from "./deps";
import { authRoutes } from "./auth/routes";
import { sessionRoutes } from "./sessions/routes";
import { academyRoutes } from "./academy/routes";

const API = config.app.apiBase;
/** First path segments of API routes, for proxies that strip the /api prefix (Caddy handle_path). */
const API_ROOTS = new Set(["me", "sessions", "scenarios", "health", "ws", "v1", "academy"]);

export function originAllowed(origin: string): boolean {
  return origin === new URL(config.app.publicUrl).origin || config.app.corsOrigins.some((o) => (typeof o === "string" ? o === origin : o.test(origin)));
}

/** Put the /api prefix back when a reverse proxy stripped it. */
export function rewriteUrl(url: string): string {
  if (url.startsWith(`${API}/`) || url === API || url.startsWith(config.app.authCallbackPath)) return url;
  const first = url.split(/[/?]/)[1] ?? "";
  if (API_ROOTS.has(first) || (first === "auth" && !url.startsWith(config.app.authCallbackPath))) return `${API}${url}`;
  return url;
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.env.NODE_ENV === "test" ? false : { level: deps.env.isDev ? "info" : "warn" },
    trustProxy: config.app.trustProxy,
    bodyLimit: config.session.maxScriptBytes + 64 * 1024,
    rewriteUrl: (req) => rewriteUrl(req.url ?? "/"),
  });

  await app.register(cookie);

  // CORS for the configured origins (credentials included); same-origin requests need nothing.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
      if (req.method === "OPTIONS") {
        reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
        return reply.code(204).send();
      }
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code, ...err.extra });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: "Request body is too large", code: "BAD_INPUT" });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: err.message, code: "BAD_INPUT" });
    req.log.error(err);
    return reply.code(500).send({ error: "Something went wrong on the server", code: "SERVER_ERROR" });
  });

  app.get(`${API}/health`, async () => ({ ok: true, name: config.app.name }));
  authRoutes(app, deps);
  sessionRoutes(app, deps);
  await academyRoutes(app, deps);

  const webDist = path.resolve(repoRoot(), config.app.webDistDir);
  if (deps.env.serveWeb && fs.existsSync(path.join(webDist, "index.html"))) {
    // no Caddy in front (Docker, `pnpm serve` behind a tunnel): the headers it would add
    app.addHook("onSend", async (_req, reply) => {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
      reply.header("X-Frame-Options", "DENY");
    });
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // hashed build assets never change; everything else is checked again on every load
      cacheControl: false,
      setHeaders: (res, file) => {
        res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith(API)) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found", code: "BAD_INPUT" });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found", code: "BAD_INPUT" }));
  }
  return app;
}
