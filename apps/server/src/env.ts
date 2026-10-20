// Secrets and per-machine overrides from .env (never from sweatbox.config.ts, never sent to clients,
// never logged).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

/** Repository root (works from src/ under tsx and from dist/ when bundled). */
export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]).default("production"),
  DISCORD_CLIENT_ID: z.string().default(""),
  DISCORD_CLIENT_SECRET: z.string().default(""),
  DISCORD_BOT_TOKEN: z.string().default(""),
  DISCORD_REDIRECT_URI: z.string().default(""),
  SESSION_SIGNING_SECRET: z.string().default(""),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? Number(v) : undefined))
    .pipe(z.number().int().min(1).max(65535).optional()),
  BIND_HOST: z.string().optional(),
  SERVE_WEB: z.string().optional(),
  DEV_FAKE_USER: z.enum(["host", "viewer", ""]).default(""),
  DB_PATH: z.string().optional(),
  // ATC24Academy integration (docs/academy-integration.md); off while ACADEMY_BASE_URL is empty
  ACADEMY_BASE_URL: z.string().trim().default(""),
  /** SHA-256 (hex) of the academy's API key; comma-separated while rotating keys. */
  ACADEMY_API_KEY_HASH: z.string().trim().default(""),
  ACADEMY_WEBHOOK_SECRET: z.string().trim().default(""),
  ACADEMY_LAUNCH_TOKEN_TTL_SECONDS: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? Number(v) : 300))
    .pipe(z.number().int().min(30).max(300)),
});

export type Env = z.infer<typeof EnvSchema> & { isDev: boolean; serveWeb: boolean; academyOrigin: string | null; academyKeyHashes: string[] };

const HEX64 = /^[0-9a-f]{64}$/;

/** The academy settings, checked (names only in errors, never values). */
function academySettings(env: z.infer<typeof EnvSchema>, isDev: boolean): { academyOrigin: string | null; academyKeyHashes: string[] } {
  if (!env.ACADEMY_BASE_URL) return { academyOrigin: null, academyKeyHashes: [] };
  let url: URL;
  try {
    url = new URL(env.ACADEMY_BASE_URL);
  } catch {
    throw new Error(".env: ACADEMY_BASE_URL is not a URL");
  }
  if (url.protocol !== "https:" && !(isDev && url.protocol === "http:")) throw new Error(".env: ACADEMY_BASE_URL must be https");
  const hashes = env.ACADEMY_API_KEY_HASH.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!hashes.length || !hashes.every((h) => HEX64.test(h))) throw new Error(".env: ACADEMY_API_KEY_HASH must be the SHA-256 hex of the academy API key");
  if (env.ACADEMY_WEBHOOK_SECRET.length < 32) throw new Error(".env: ACADEMY_WEBHOOK_SECRET must be at least 32 characters");
  return { academyOrigin: url.origin, academyKeyHashes: hashes };
}

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  dotenv.config({ path: path.join(repoRoot(), ".env"), quiet: true } as dotenv.DotenvConfigOptions);
  const raw = { ...process.env, ...overrides };
  const res = EnvSchema.safeParse(raw);
  if (!res.success) {
    // only print variable names, never values
    const keys = res.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`.env is invalid (check: ${keys})`);
  }
  const env = res.data;
  const isDev = env.NODE_ENV !== "production";
  if (!isDev) {
    const missing = (["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "SESSION_SIGNING_SECRET"] as const).filter(
      (k) => !env[k],
    );
    if (missing.length) throw new Error(`.env is missing ${missing.join(", ")} (required in production)`);
    if (env.SESSION_SIGNING_SECRET.length < 32) throw new Error("SESSION_SIGNING_SECRET must be at least 32 characters");
    if (env.DEV_FAKE_USER) throw new Error("DEV_FAKE_USER is only allowed with NODE_ENV=development");
  }
  return {
    ...env,
    // a stable dev secret so restarts keep dev logins working; production requires a real one
    SESSION_SIGNING_SECRET: env.SESSION_SIGNING_SECRET || "development-only-signing-secret-change-me-please-0123456789",
    isDev,
    serveWeb: env.SERVE_WEB === "1" || env.SERVE_WEB === "true",
    ...academySettings(env, isDev),
  };
}
