// ATC24Academy Sweatbox server entry point.
import path from "node:path";
import { config } from "@sweatbox/config"; // validates sweatbox.config.ts (fails fast with a clear message)
import { loadEnv, repoRoot } from "./env";
import { Store } from "./db";
import { Secrets } from "./crypto";
import { DiscordClient } from "./auth/discord";
import { AuthService } from "./auth/service";
import { SessionManager } from "./sessions/manager";
import { ScenarioLibrary } from "./sessions/scenarios";
import { RateLimiter } from "./rateLimit";
import { buildApp } from "./app";
import { attachWebSocket } from "./ws";
import { AcademyService } from "./academy/service";
import { AcademyStore } from "./academy/store";
import { CallbackOutbox } from "./academy/outbox";
import { DiscordHostInviter } from "./academy/invite";
import type { Deps } from "./deps";

async function main() {
  const env = loadEnv();
  const root = repoRoot();
  const store = new Store(env.DB_PATH ?? path.resolve(root, config.data.dbPath));
  const secrets = new Secrets(env.SESSION_SIGNING_SECRET);
  const discord = new DiscordClient(env);
  const sessions = new SessionManager(store);
  const outbox = new CallbackOutbox(new AcademyStore(store.db), { secret: env.ACADEMY_WEBHOOK_SECRET, origin: env.academyOrigin });
  const deps: Deps = {
    env,
    store,
    secrets,
    discord,
    auth: new AuthService(store, env, discord, secrets),
    sessions,
    scenarios: new ScenarioLibrary(path.resolve(root, config.data.scenariosDir)),
    limiter: new RateLimiter(),
    academy: new AcademyService(store, sessions, secrets, env, new DiscordHostInviter(discord), outbox),
  };

  const app = await buildApp(deps);
  const ws = attachWebSocket(app.server, deps);
  sessions.start();
  outbox.start();
  const purge = setInterval(() => store.purgeExpired(), 3_600_000);

  const port = env.PORT ?? config.app.port;
  const host = env.BIND_HOST ?? config.app.bindHost;
  await app.listen({ port, host });
  console.log(`${config.app.name} listening on http://${host}:${port}${env.isDev ? " (development)" : ""}`);
  if (env.isDev && env.DEV_FAKE_USER) console.log(`DEV_FAKE_USER=${env.DEV_FAKE_USER}: everyone is logged in as a fake ${env.DEV_FAKE_USER}`);
  if (!discord.configured) console.log("Discord OAuth is not configured (.env): only the development login works");
  console.log(deps.academy.enabled ? `ATC24Academy integration on (callbacks to ${env.academyOrigin})` : "ATC24Academy integration off (ACADEMY_BASE_URL is empty)");

  const shutdown = async () => {
    clearInterval(purge);
    sessions.stop();
    outbox.stop();
    ws.close();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e: unknown) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
