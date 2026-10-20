// SQLite persistence (better-sqlite3): accounts, auth sessions, encrypted Discord tokens, archived
// replays and the ATC24Academy integration (apps/server/src/academy). Live sessions stay in memory.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  is_host: number;
  reauth: number;
  in_guild: number;
  roles_checked_at: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL,
     display_name TEXT NOT NULL,
     avatar TEXT,
     is_host INTEGER NOT NULL DEFAULT 0,
     reauth INTEGER NOT NULL DEFAULT 0,
     in_guild INTEGER NOT NULL DEFAULT 1,
     roles_checked_at INTEGER NOT NULL DEFAULT 0,
     access_token TEXT,
     refresh_token TEXT,
     token_expires_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE auth_sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
   CREATE TABLE replays (
     code TEXT PRIMARY KEY,
     ended_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     json TEXT NOT NULL
   );`,
  // 2: ATC24Academy integration
  `CREATE TABLE academy_sessions (
     id TEXT PRIMARY KEY,
     reference TEXT NOT NULL UNIQUE,
     student_id TEXT NOT NULL,
     student_discord_id TEXT NOT NULL,
     student_username TEXT NOT NULL,
     course_id TEXT NOT NULL,
     course_title TEXT NOT NULL,
     module_id TEXT NOT NULL,
     module_title TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     attempt_number INTEGER NOT NULL,
     host_discord_id TEXT NOT NULL,
     host_name TEXT,
     scheduled_at INTEGER NOT NULL,
     assessment_type TEXT,
     instructions TEXT NOT NULL,
     passing_criteria TEXT NOT NULL,
     return_url TEXT NOT NULL,
     callback_url TEXT NOT NULL,
     launch_token_enc TEXT NOT NULL,
     status TEXT NOT NULL,
     invite_status TEXT NOT NULL,
     invite_error TEXT,
     live_code TEXT,
     student_admitted_at INTEGER,
     outcome TEXT,
     score INTEGER,
     feedback TEXT,
     completed_at INTEGER,
     completed_by TEXT,
     cancel_reason TEXT,
     cancelled_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX academy_sessions_host ON academy_sessions(host_discord_id, status);
   CREATE INDEX academy_sessions_live ON academy_sessions(live_code);
   CREATE TABLE academy_idempotency (
     key TEXT PRIMARY KEY,
     request_hash TEXT NOT NULL,
     session_id TEXT NOT NULL REFERENCES academy_sessions(id),
     created_at INTEGER NOT NULL
   );
   CREATE TABLE academy_launch_tokens (
     token_hash TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES academy_sessions(id),
     student_discord_id TEXT NOT NULL,
     single_use INTEGER NOT NULL,
     expires_at INTEGER,
     used_at INTEGER,
     revoked_at INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX academy_launch_tokens_session ON academy_launch_tokens(session_id);
   CREATE TABLE academy_outbox (
     event_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES academy_sessions(id),
     type TEXT NOT NULL,
     url TEXT NOT NULL,
     body TEXT NOT NULL,
     status TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     last_status INTEGER,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     delivered_at INTEGER
   );
   CREATE INDEX academy_outbox_due ON academy_outbox(status, next_attempt_at);
   CREATE UNIQUE INDEX academy_outbox_one_completed ON academy_outbox(session_id) WHERE type = 'session.completed';
   CREATE TABLE academy_audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     session_id TEXT,
     action TEXT NOT NULL,
     detail TEXT
   );`,
];

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const version = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec(MIGRATIONS[v]!);
      this.db.pragma(`user_version = ${v + 1}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- users -----------------------------------------------------------------------------------------

  getUser(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  }

  upsertUser(u: Omit<UserRow, "created_at" | "updated_at">): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, avatar, is_host, reauth, in_guild, roles_checked_at,
                            access_token, refresh_token, token_expires_at, created_at, updated_at)
         VALUES (@id, @username, @display_name, @avatar, @is_host, @reauth, @in_guild, @roles_checked_at,
                 @access_token, @refresh_token, @token_expires_at, @now, @now)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
           avatar = excluded.avatar, is_host = excluded.is_host, reauth = excluded.reauth, in_guild = excluded.in_guild,
           roles_checked_at = excluded.roles_checked_at, access_token = excluded.access_token,
           refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at, updated_at = @now`,
      )
      .run({ ...u, now });
  }

  updateUser(id: string, fields: Partial<Omit<UserRow, "id" | "created_at">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE users SET ${set}, updated_at = @__now WHERE id = @__id`).run({ ...fields, __now: Date.now(), __id: id });
  }

  // ---- auth sessions ---------------------------------------------------------------------------------

  createAuthSession(tokenHash: string, userId: string, ttlMs: number): void {
    const now = Date.now();
    this.db.prepare("INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(tokenHash, userId, now, now + ttlMs);
  }

  /** User id for a live auth session, or undefined. */
  getAuthSession(tokenHash: string): string | undefined {
    const row = this.db.prepare("SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?").get(tokenHash) as
      | { user_id: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) {
      this.deleteAuthSession(tokenHash);
      return undefined;
    }
    return row.user_id;
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
  }

  // ---- replays ---------------------------------------------------------------------------------------

  archiveReplay(code: string, endedAt: number, expiresAt: number, json: string): void {
    this.db
      .prepare("INSERT INTO replays (code, ended_at, expires_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET ended_at = excluded.ended_at, expires_at = excluded.expires_at, json = excluded.json")
      .run(code, endedAt, expiresAt, json);
  }

  /** A live (unexpired) archived replay exists for this code. */
  replayExists(code: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM replays WHERE code = ? AND expires_at >= ?").get(code, Date.now()));
  }

  getReplay(code: string): string | undefined {
    const row = this.db.prepare("SELECT json, expires_at FROM replays WHERE code = ?").get(code) as { json: string; expires_at: number } | undefined;
    return row && row.expires_at >= Date.now() ? row.json : undefined;
  }

  // ---- housekeeping ----------------------------------------------------------------------------------

  purgeExpired(): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM replays WHERE expires_at < ?").run(now);
  }
}
