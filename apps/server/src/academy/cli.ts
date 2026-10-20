// Operator commands for the ATC24Academy integration (docs/academy-integration.md):
//   pnpm academy keys                 new API key (+ its hash) and webhook secret
//   pnpm academy hash < key.txt       ACADEMY_API_KEY_HASH for an existing key (read from stdin)
//   pnpm academy outbox [status]      callbacks (pending | delivered | failed)
//   pnpm academy retry <eventId|failed>  send a failed callback again (same eventId)
// In a production build: node apps/server/dist/cli.js <command>.
import crypto from "node:crypto";
import path from "node:path";
import { config } from "@sweatbox/config";
import { loadEnv, repoRoot } from "../env";
import { Store } from "../db";
import { AcademyStore, type OutboxStatus } from "./store";
import { hashApiKey } from "./signing";

const [cmd, arg] = process.argv.slice(2);

function openStore(): AcademyStore {
  const env = loadEnv();
  return new AcademyStore(new Store(env.DB_PATH ?? path.resolve(repoRoot(), config.data.dbPath)).db);
}

async function main(): Promise<void> {
  if (cmd === "keys") {
    const key = crypto.randomBytes(32).toString("hex");
    const secret = crypto.randomBytes(32).toString("hex");
    console.log("# Sweatbox .env");
    console.log(`ACADEMY_API_KEY_HASH=${hashApiKey(key)}`);
    console.log(`ACADEMY_WEBHOOK_SECRET=${secret}`);
    console.log("\n# ATC24Academy .env (the raw key is shown only here)");
    console.log(`SWEATBOX_API_KEY=${key}`);
    console.log(`SWEATBOX_WEBHOOK_SECRET=${secret}`);
    return;
  }
  if (cmd === "hash") {
    let key = "";
    for await (const chunk of process.stdin) key += String(chunk);
    key = key.trim();
    if (!key) throw new Error("Pipe the API key in: pnpm academy hash < key.txt");
    console.log(hashApiKey(key));
    return;
  }
  if (cmd === "outbox") {
    const status = arg as OutboxStatus | undefined;
    if (status && !["pending", "delivered", "failed"].includes(status)) throw new Error("Status is pending, delivered or failed");
    const rows = openStore().events(status);
    if (!rows.length) console.log("No callbacks");
    for (const r of rows)
      console.log(
        `${r.event_id}  ${r.type.padEnd(17)} ${r.status.padEnd(9)} attempts ${r.attempts}  session ${r.session_id}  queued ${new Date(r.created_at).toISOString()}${r.last_error ? `\n    last error: ${r.last_error}` : ""}`,
      );
    return;
  }
  if (cmd === "retry") {
    if (!arg) throw new Error("Usage: pnpm academy retry <eventId|failed>");
    const store = openStore();
    const rows = arg === "failed" ? store.events("failed") : [store.getEvent(arg)].filter((r) => r !== undefined);
    if (!rows.length) throw new Error(arg === "failed" ? "No failed callbacks" : `No callback ${arg}`);
    for (const r of rows) {
      if (r.status === "delivered") {
        console.log(`${r.event_id} was already delivered`);
        continue;
      }
      // a new retry window from now; the body (and its eventId) stay the same
      store.updateEvent(r.event_id, { status: "pending", next_attempt_at: Date.now(), created_at: Date.now(), last_error: null });
      store.audit(r.session_id, "callback_requeued", r.event_id);
      console.log(`${r.event_id} queued again (the running server sends it within ${config.academy.outboxPollSec} s)`);
    }
    return;
  }
  console.log("Commands: keys | hash | outbox [pending|delivered|failed] | retry <eventId|failed>");
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
