// SQLite access for the ATC24Academy integration (tables from migration 2 in ../db.ts).
import type Database from "better-sqlite3";
import type { AcademyStatus } from "@sweatbox/shared";

export type InviteStatus = "sent" | "pending" | "failed";
export type OutboxStatus = "pending" | "delivered" | "failed";
export type CallbackType = "session.completed" | "replay.available" | "replay.failed";

export interface AcademySessionRow {
  id: string;
  reference: string;
  student_id: string;
  student_discord_id: string;
  student_username: string;
  course_id: string;
  course_title: string;
  module_id: string;
  module_title: string;
  attempt_id: string;
  attempt_number: number;
  host_discord_id: string;
  host_name: string | null;
  scheduled_at: number;
  assessment_type: string | null;
  instructions: string;
  passing_criteria: string;
  return_url: string;
  callback_url: string;
  launch_token_enc: string;
  status: AcademyStatus;
  invite_status: InviteStatus;
  invite_error: string | null;
  live_code: string | null;
  student_admitted_at: number | null;
  outcome: "pass" | "fail" | null;
  score: number | null;
  feedback: string | null;
  completed_at: number | null;
  completed_by: string | null;
  cancel_reason: string | null;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LaunchTokenRow {
  token_hash: string;
  session_id: string;
  student_discord_id: string;
  single_use: number;
  expires_at: number | null;
  used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface OutboxRow {
  event_id: string;
  session_id: string;
  type: CallbackType;
  url: string;
  body: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: number;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
}

export type NewAcademySession = Omit<
  AcademySessionRow,
  | "status"
  | "invite_status"
  | "invite_error"
  | "live_code"
  | "student_admitted_at"
  | "outcome"
  | "score"
  | "feedback"
  | "completed_at"
  | "completed_by"
  | "cancel_reason"
  | "cancelled_at"
  | "created_at"
  | "updated_at"
>;

export class AcademyStore {
  constructor(private db: Database.Database) {}

  /** Run `fn` in one SQLite transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- sessions --------------------------------------------------------------------------------------

  insertSession(s: NewAcademySession, requestHash: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO academy_sessions (id, reference, student_id, student_discord_id, student_username, course_id, course_title,
           module_id, module_title, attempt_id, attempt_number, host_discord_id, host_name, scheduled_at, assessment_type,
           instructions, passing_criteria, return_url, callback_url, launch_token_enc, status, invite_status, created_at, updated_at)
         VALUES (@id, @reference, @student_id, @student_discord_id, @student_username, @course_id, @course_title,
           @module_id, @module_title, @attempt_id, @attempt_number, @host_discord_id, @host_name, @scheduled_at, @assessment_type,
           @instructions, @passing_criteria, @return_url, @callback_url, @launch_token_enc, 'reserved', 'pending', @now, @now)`,
      )
      .run({ ...s, now });
    this.db.prepare("INSERT INTO academy_idempotency (key, request_hash, session_id, created_at) VALUES (?, ?, ?, ?)").run(s.reference, requestHash, s.id, now);
  }

  getSession(id: string): AcademySessionRow | undefined {
    return this.db.prepare("SELECT * FROM academy_sessions WHERE id = ?").get(id) as AcademySessionRow | undefined;
  }

  sessionForLiveCode(code: string): AcademySessionRow | undefined {
    return this.db.prepare("SELECT * FROM academy_sessions WHERE live_code = ?").get(code) as AcademySessionRow | undefined;
  }

  /** Reservations for a host (every host's when `hostId` is null), soonest first, recent results included. */
  sessionsForHost(hostId: string | null, since: number): AcademySessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM academy_sessions
         WHERE (@host IS NULL OR host_discord_id = @host) AND (status = 'reserved' OR updated_at >= @since)
         ORDER BY scheduled_at`,
      )
      .all({ host: hostId, since }) as AcademySessionRow[];
  }

  updateSession(id: string, fields: Partial<Omit<AcademySessionRow, "id" | "created_at">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE academy_sessions SET ${set}, updated_at = @__now WHERE id = @__id`).run({ ...fields, __now: Date.now(), __id: id });
  }

  // ---- idempotency -----------------------------------------------------------------------------------

  idempotency(key: string): { request_hash: string; session_id: string } | undefined {
    return this.db.prepare("SELECT request_hash, session_id FROM academy_idempotency WHERE key = ?").get(key) as
      | { request_hash: string; session_id: string }
      | undefined;
  }

  recordIdempotency(key: string, requestHash: string, sessionId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO academy_idempotency (key, request_hash, session_id, created_at) VALUES (?, ?, ?, ?)").run(key, requestHash, sessionId, Date.now());
  }

  // ---- launch tokens ---------------------------------------------------------------------------------

  insertToken(t: Omit<LaunchTokenRow, "used_at" | "revoked_at" | "created_at">): void {
    this.db
      .prepare(
        `INSERT INTO academy_launch_tokens (token_hash, session_id, student_discord_id, single_use, expires_at, created_at)
         VALUES (@token_hash, @session_id, @student_discord_id, @single_use, @expires_at, @now)`,
      )
      .run({ ...t, now: Date.now() });
  }

  getToken(tokenHash: string): LaunchTokenRow | undefined {
    return this.db.prepare("SELECT * FROM academy_launch_tokens WHERE token_hash = ?").get(tokenHash) as LaunchTokenRow | undefined;
  }

  /** Mark a single-use token used; false when someone else used it first. */
  useToken(tokenHash: string): boolean {
    return this.db.prepare("UPDATE academy_launch_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").run(Date.now(), tokenHash).changes === 1;
  }

  revokeTokens(sessionId: string): void {
    this.db.prepare("UPDATE academy_launch_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL").run(Date.now(), sessionId);
  }

  // ---- callback outbox -------------------------------------------------------------------------------

  enqueue(e: { event_id: string; session_id: string; type: CallbackType; url: string; body: string }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO academy_outbox (event_id, session_id, type, url, body, status, next_attempt_at, created_at)
         VALUES (@event_id, @session_id, @type, @url, @body, 'pending', @now, @now)`,
      )
      .run({ ...e, now });
  }

  dueEvents(now: number, limit = 20): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM academy_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
      .all(now, limit) as OutboxRow[];
  }

  getEvent(eventId: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM academy_outbox WHERE event_id = ?").get(eventId) as OutboxRow | undefined;
  }

  eventsFor(sessionId: string): OutboxRow[] {
    return this.db.prepare("SELECT * FROM academy_outbox WHERE session_id = ? ORDER BY created_at").all(sessionId) as OutboxRow[];
  }

  events(status?: OutboxStatus): OutboxRow[] {
    return (status
      ? this.db.prepare("SELECT * FROM academy_outbox WHERE status = ? ORDER BY created_at").all(status)
      : this.db.prepare("SELECT * FROM academy_outbox ORDER BY created_at").all()) as OutboxRow[];
  }

  updateEvent(eventId: string, fields: Partial<Pick<OutboxRow, "status" | "attempts" | "next_attempt_at" | "last_status" | "last_error" | "delivered_at" | "created_at">>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE academy_outbox SET ${set} WHERE event_id = @__id`).run({ ...fields, __id: eventId });
  }

  // ---- audit -----------------------------------------------------------------------------------------

  audit(sessionId: string | null, action: string, detail?: string): void {
    this.db.prepare("INSERT INTO academy_audit (at, session_id, action, detail) VALUES (?, ?, ?, ?)").run(Date.now(), sessionId, action, detail ?? null);
  }

  auditFor(sessionId: string): { at: number; action: string; detail: string | null }[] {
    return this.db.prepare("SELECT at, action, detail FROM academy_audit WHERE session_id = ? ORDER BY id").all(sessionId) as {
      at: number;
      action: string;
      detail: string | null;
    }[];
  }
}
