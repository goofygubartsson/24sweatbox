// ATC24Academy integration (docs/academy-integration.md): sessions the academy books for a student,
// the host's invitation, the student's launch links, and the signed result callbacks.
//
// A booking is stored in academy_sessions. When it's time, the booked host starts it from the home
// page, which creates an ordinary live session (SessionManager.create) linked to the booking; only
// the hosts and the booked student (after using a launch link) can join it. The host ends it by
// recording pass / fail, which queues the session.completed callback in the outbox.
import { z } from "zod";
import { config } from "@sweatbox/config";
import type { AcademyCompleteBody, AcademyView } from "@sweatbox/shared";
import { HttpError } from "../errors";
import { randomToken, sha256, type Secrets } from "../crypto";
import type { Store, UserRow } from "../db";
import type { Env } from "../env";
import type { SessionManager } from "../sessions/manager";
import type { Session } from "../sim/session";
import type { HostInviter } from "./invite";
import type { CallbackOutbox } from "./outbox";
import { AcademyStore, type AcademySessionRow, type CallbackType, type InviteStatus } from "./store";

const A = config.academy;
const PUBLIC = config.app.publicUrl.replace(/\/+$/, "");
/** Results of the last week stay in the host's list. */
const RECENT_MS = 7 * 86_400_000;

// ---- the academy's request bodies ---------------------------------------------------------------------

/** Discord snowflakes: digit strings (never numbers, they exceed 2^53). */
const DiscordId = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (a string of 17-20 digits)");
const Uuid = z.string().uuid();
const Title = z.string().trim().min(1).max(300);
const HttpUrl = z
  .string()
  .max(2000)
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), "must be an http(s) URL");

export const ReserveBody = z.object({
  reference: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._~-]+$/, "letters, digits and . _ ~ - only"),
  student: z.object({ id: Uuid, discordId: DiscordId, username: z.string().trim().min(1).max(100) }),
  course: z.object({ id: Uuid, title: Title }),
  module: z.object({ id: Uuid, title: Title }),
  attempt: z.object({ id: Uuid, number: z.number().int().min(1).max(10_000) }),
  host: z.object({ discordId: DiscordId, name: z.string().trim().max(100).nullable() }),
  scheduledAt: z.string().datetime({ offset: true }),
  assessmentType: z.string().trim().max(100).nullable(),
  instructions: z.string().max(20_000),
  passingCriteria: z.string().max(20_000),
  returnUrl: HttpUrl,
  callbackUrl: HttpUrl,
});
export type ReserveBody = z.infer<typeof ReserveBody>;

export const CancelBody = z.object({ reason: z.string().max(1000).default("") });
export const LaunchTokenBody = z.object({ studentDiscordId: DiscordId });

export const SESSION_ID_RE = /^sb_[A-Za-z0-9_-]{8,100}$/;

export interface ReserveResponse {
  sessionId: string;
  launchUrl: string;
  status: string;
  hostInvite: { status: InviteStatus; error?: string };
}

/** Thrown for a launch link that can't be used; `returnUrl` lets the page send the student back. */
const closed = (status: number, message: string, returnUrl?: string) =>
  new HttpError(status, status === 403 ? "WRONG_ACCOUNT" : "LINK_CLOSED", message, returnUrl ? { returnUrl } : {});

export class AcademyService {
  readonly store: AcademyStore;
  private invites = new Map<string, Promise<{ status: InviteStatus; error?: string }>>();

  constructor(
    private mainStore: Store,
    private sessions: SessionManager,
    private secrets: Secrets,
    private env: Env,
    private inviter: HostInviter,
    readonly outbox: CallbackOutbox,
  ) {
    this.store = new AcademyStore(mainStore.db);
  }

  get enabled(): boolean {
    return this.env.academyOrigin !== null && this.env.academyKeyHashes.length > 0;
  }

  // ---- POST /v1/sessions ---------------------------------------------------------------------------------

  async reserve(body: ReserveBody, idempotencyKey: string | undefined): Promise<{ created: boolean; response: ReserveResponse }> {
    if (!idempotencyKey) throw new HttpError(400, "BAD_INPUT", "The Idempotency-Key header is required");
    if (idempotencyKey !== body.reference) throw new HttpError(422, "BAD_INPUT", "Idempotency-Key must equal reference");
    if (new URL(body.callbackUrl).origin !== this.env.academyOrigin) throw new HttpError(422, "BAD_INPUT", "callbackUrl must be on the configured academy origin");
    if (new URL(body.returnUrl).origin !== this.env.academyOrigin) throw new HttpError(422, "BAD_INPUT", "returnUrl must be on the configured academy origin");

    const hash = sha256(JSON.stringify(body));
    const seen = this.store.idempotency(idempotencyKey);
    if (seen) {
      if (seen.request_hash !== hash) throw new HttpError(409, "REJECTED", "This reference was already used for a session with different details");
      const row = this.store.getSession(seen.session_id)!;
      // a failed (or interrupted) invitation is tried again on every retry of the same request
      const retry = row.status === "reserved" && (row.invite_status === "failed" || (row.invite_status === "pending" && !this.invites.has(row.id)));
      const invite = retry ? await this.invite(row) : { status: row.invite_status, ...(row.invite_error ? { error: row.invite_error } : {}) };
      return { created: false, response: this.reserveResponse(this.store.getSession(row.id)!, invite) };
    }

    const id = `sb_${randomToken(18)}`;
    const token = randomToken(32);
    this.store.tx(() => {
      this.store.insertSession(
        {
          id,
          reference: body.reference,
          student_id: body.student.id,
          student_discord_id: body.student.discordId,
          student_username: body.student.username,
          course_id: body.course.id,
          course_title: body.course.title,
          module_id: body.module.id,
          module_title: body.module.title,
          attempt_id: body.attempt.id,
          attempt_number: body.attempt.number,
          host_discord_id: body.host.discordId,
          host_name: body.host.name || null,
          scheduled_at: Date.parse(body.scheduledAt),
          assessment_type: body.assessmentType || null,
          instructions: body.instructions,
          passing_criteria: body.passingCriteria,
          return_url: body.returnUrl,
          callback_url: body.callbackUrl,
          launch_token_enc: this.secrets.encrypt(token),
        },
        hash,
      );
      this.store.insertToken({ token_hash: sha256(token), session_id: id, student_discord_id: body.student.discordId, single_use: 0, expires_at: null });
      this.store.audit(id, "created", `reference ${body.reference}, attempt ${body.attempt.number}, host ${body.host.discordId}, at ${body.scheduledAt}`);
    });
    const invite = await this.invite(this.store.getSession(id)!);
    return { created: true, response: this.reserveResponse(this.store.getSession(id)!, invite) };
  }

  private reserveResponse(row: AcademySessionRow, invite: { status: InviteStatus; error?: string }): ReserveResponse {
    return {
      sessionId: row.id,
      launchUrl: `${PUBLIC}/join/${this.linkToken(row)}`,
      status: row.status,
      hostInvite: invite.status === "failed" ? { status: "failed", error: (invite.error ?? "The invitation failed").slice(0, 500) } : { status: invite.status },
    };
  }

  /** The session's long-lived launch token (stored encrypted, so retries return the same URL). */
  private linkToken(row: AcademySessionRow): string {
    const t = this.secrets.decrypt(row.launch_token_enc);
    if (t) return t;
    // SESSION_SIGNING_SECRET changed since the booking: issue a new link
    const token = randomToken(32);
    this.store.tx(() => {
      this.store.insertToken({ token_hash: sha256(token), session_id: row.id, student_discord_id: row.student_discord_id, single_use: 0, expires_at: null });
      this.store.updateSession(row.id, { launch_token_enc: this.secrets.encrypt(token) });
      if (row.status !== "reserved") this.store.revokeTokens(row.id);
    });
    return token;
  }

  /** Invite the host; answers within hostInviteWaitMs ("pending" if Discord is slower). */
  private invite(row: AcademySessionRow): Promise<{ status: InviteStatus; error?: string }> {
    let p = this.invites.get(row.id);
    if (!p) {
      this.store.updateSession(row.id, { invite_status: "pending", invite_error: null });
      p = this.inviter
        .notify(row, "invite")
        .catch((e: unknown) => ({ ok: false as const, error: `The invitation failed: ${(e as Error).message}` }))
        .then((r) => {
          if (r.ok) {
            this.store.updateSession(row.id, { invite_status: "sent", invite_error: null });
            this.store.audit(row.id, "host_invited", row.host_discord_id);
            return { status: "sent" as const };
          }
          const error = r.error.slice(0, 500);
          this.store.updateSession(row.id, { invite_status: "failed", invite_error: error });
          this.store.audit(row.id, "host_invite_failed", error);
          console.warn(`[academy] host invite failed for ${row.id}: ${error}`);
          return { status: "failed" as const, error };
        })
        .finally(() => this.invites.delete(row.id));
      this.invites.set(row.id, p);
    }
    let timer: NodeJS.Timeout | undefined;
    const wait = new Promise<{ status: InviteStatus }>((resolve) => {
      timer = setTimeout(() => resolve({ status: "pending" }), A.hostInviteWaitMs);
      timer.unref?.();
    });
    return Promise.race([p, wait]).finally(() => clearTimeout(timer));
  }

  // ---- POST /v1/sessions/:id/cancel ----------------------------------------------------------------------

  cancel(id: string, reason: string, idempotencyKey: string | undefined): { ok: true; status: "cancelled" } {
    const row = this.rowOr404(id);
    if (idempotencyKey && idempotencyKey !== `${row.reference}:cancel`) throw new HttpError(422, "BAD_INPUT", "Idempotency-Key must be <reference>:cancel");
    if (row.status === "cancelled") return { ok: true, status: "cancelled" };
    if (row.status === "completed") throw new HttpError(409, "REJECTED", "The session is already completed; it can't be cancelled");
    this.store.tx(() => {
      this.store.updateSession(id, { status: "cancelled", cancel_reason: reason.trim() || null, cancelled_at: Date.now() });
      this.store.revokeTokens(id);
      this.store.recordIdempotency(`${row.reference}:cancel`, sha256(reason), id);
      this.store.audit(id, "cancelled", reason.trim() || "(no reason)");
    });
    const live = row.live_code ? this.sessions.get(row.live_code) : undefined;
    if (live && !live.ended) {
      live.log("ATC24Academy cancelled this session", "warn");
      this.sessions.end(live);
    }
    if (row.invite_status === "sent") {
      void this.inviter
        .notify(this.store.getSession(id)!, "cancel")
        .then((r) => this.store.audit(id, r.ok ? "host_told_cancelled" : "host_cancel_notice_failed", r.ok ? undefined : r.error))
        .catch(() => undefined);
    }
    return { ok: true, status: "cancelled" };
  }

  // ---- POST /v1/sessions/:id/launch-tokens ---------------------------------------------------------------

  launchToken(id: string, studentDiscordId: string): { launchUrl: string; expiresAt: string } {
    const row = this.rowOr404(id);
    if (row.student_discord_id !== studentDiscordId) throw new HttpError(403, "REJECTED", "studentDiscordId is not this session's student");
    if (row.status !== "reserved") throw new HttpError(409, "REJECTED", `The session is ${row.status}`);
    const token = randomToken(32);
    const expiresAt = Date.now() + this.env.ACADEMY_LAUNCH_TOKEN_TTL_SECONDS * 1000;
    this.store.insertToken({ token_hash: sha256(token), session_id: id, student_discord_id: studentDiscordId, single_use: 1, expires_at: expiresAt });
    this.store.audit(id, "launch_token_issued");
    return { launchUrl: `${PUBLIC}/join?token=${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  // ---- the student's launch (web) ------------------------------------------------------------------------

  launch(token: string, user: UserRow): AcademyView {
    const hash = sha256(token);
    const t = this.store.getToken(hash);
    if (!t) throw closed(404, "That launch link isn't valid. Launch the session again from ATC24Academy.");
    const row = this.store.getSession(t.session_id)!;
    if (row.status === "cancelled") throw closed(410, "This session was cancelled.", row.return_url);
    if (row.status === "completed") throw closed(410, "This session has finished.", row.return_url);
    if (t.revoked_at || (t.single_use && (t.used_at || (t.expires_at ?? 0) < Date.now())))
      throw closed(410, "This launch link has expired. Launch the session again from ATC24Academy.", row.return_url);
    if (user.id !== t.student_discord_id) {
      this.store.audit(row.id, "launch_wrong_account", user.id);
      throw closed(403, "This session belongs to a different student. Log in with the Discord account linked to your ATC24Academy profile.", row.return_url);
    }
    if (t.single_use && !this.store.useToken(hash)) throw closed(410, "This launch link was already used. Launch the session again from ATC24Academy.", row.return_url);
    if (!row.student_admitted_at) this.store.updateSession(row.id, { student_admitted_at: Date.now() });
    this.store.audit(row.id, "student_launched", t.single_use ? "one-time link" : "session link");
    return this.view(this.store.getSession(row.id)!, false);
  }

  // ---- hosts and students on the web ---------------------------------------------------------------------

  /** A booking as `user` may see it: hosts see everything, the student only after launching. */
  viewFor(id: string, user: UserRow): AcademyView {
    const row = SESSION_ID_RE.test(id) ? this.store.getSession(id) : undefined;
    if (row && user.is_host) return this.view(row, true);
    if (row && this.isAdmittedStudent(row, user)) return this.view(row, false);
    throw new HttpError(404, "NO_SESSION", "No ATC24Academy session with that id");
  }

  /** Bookings for this host (owners see every host's), soonest first. */
  hosting(user: UserRow): AcademyView[] {
    const all = config.discord.ownerIds.includes(user.id);
    return this.store.sessionsForHost(all ? null : user.id, Date.now() - RECENT_MS).map((r) => this.view(r, true));
  }

  /** Start (or reopen) the live session for a booking; returns its code. */
  start(id: string, user: UserRow): { code: string } {
    const row = this.runnable(id, user);
    if (row.status !== "reserved") throw new HttpError(409, "REJECTED", `This session is ${row.status}`);
    const live = row.live_code ? this.sessions.get(row.live_code) : undefined;
    if (live && !live.ended) return { code: live.code };
    const s = this.sessions.create(user.id);
    s.academyId = row.id;
    s.log(`ATC24Academy assessment: ${row.course_title}, ${row.module_title} (${row.student_username})`);
    this.store.updateSession(row.id, { live_code: s.code });
    this.store.audit(row.id, "started", `session ${s.code} by ${user.id}`);
    return { code: s.code };
  }

  /** The host's pass / fail: ends the live session and queues exactly one session.completed. */
  complete(id: string, user: UserRow, body: AcademyCompleteBody): AcademyView {
    const row = this.runnable(id, user);
    if (row.status === "cancelled") throw new HttpError(409, "REJECTED", "This session was cancelled; it has no result");
    if (row.status === "completed") throw new HttpError(409, "REJECTED", "The result for this session was already recorded");
    let replayUrl: string | null = null;
    let replayFailed = false;
    if (row.live_code) {
      const live = this.sessions.get(row.live_code);
      if (live && !live.ended) this.sessions.end(live);
      // replay URLs must be https for the academy
      if (this.mainStore.replayExists(row.live_code)) replayUrl = PUBLIC.startsWith("https://") ? `${PUBLIC}/replay?code=${row.live_code}` : null;
      else replayFailed = true;
    }
    const completedAt = new Date();
    const score = body.score ?? null;
    const feedback = body.feedback?.trim() ? body.feedback.trim() : null;
    this.store.tx(() => {
      const fresh = this.store.getSession(id)!;
      if (fresh.status !== "reserved") throw new HttpError(409, "REJECTED", "The result for this session was already recorded");
      this.store.updateSession(id, {
        status: "completed",
        outcome: body.outcome,
        score,
        feedback,
        completed_at: completedAt.getTime(),
        completed_by: user.id,
      });
      this.store.revokeTokens(id);
      this.enqueue(row, "session.completed", {
        sweatboxSessionId: row.id,
        studentId: row.student_id,
        studentDiscordId: row.student_discord_id,
        courseId: row.course_id,
        moduleId: row.module_id,
        attemptId: row.attempt_id,
        outcome: body.outcome,
        completedAt: completedAt.toISOString(),
        score,
        feedback,
        replayUrl,
      });
      if (replayFailed) this.enqueue(row, "replay.failed", { attemptId: row.attempt_id, replayUrl: null });
      this.store.audit(id, "completed", `${body.outcome}${score !== null ? ` ${score}` : ""} by ${user.id}`);
    });
    this.outbox.kick();
    return this.view(this.store.getSession(id)!, true);
  }

  private enqueue(row: AcademySessionRow, type: CallbackType, fields: Record<string, unknown>): void {
    const eventId = `evt_${randomToken(18)}`;
    const body = JSON.stringify({ eventId, type, sessionReference: row.reference, ...fields });
    this.store.enqueue({ event_id: eventId, session_id: row.id, type, url: row.callback_url, body });
    this.store.audit(row.id, "callback_queued", `${type} ${eventId}`);
  }

  // ---- who may join -------------------------------------------------------------------------------------

  /** Academy sessions admit the hosts and their booked student; other sessions everyone. */
  canJoin(s: Session, user: UserRow): boolean {
    if (!s.academyId || user.is_host) return true;
    const row = this.store.getSession(s.academyId);
    return Boolean(row && this.isAdmittedStudent(row, user));
  }

  /** The same rule for archived replays (looked up by session code). */
  canSeeReplay(code: string, user: UserRow): boolean {
    const row = this.store.sessionForLiveCode(code);
    return !row || Boolean(user.is_host) || this.isAdmittedStudent(row, user);
  }

  /** Academy sessions end by recording a result, not with the plain End button. */
  assertEndable(s: Session): void {
    if (!s.academyId) return;
    const row = this.store.getSession(s.academyId);
    if (row?.status === "reserved") throw new HttpError(409, "REJECTED", "This is an ATC24Academy assessment: record the result (pass or fail) to end it");
  }

  private isAdmittedStudent(row: AcademySessionRow, user: UserRow): boolean {
    return row.status !== "cancelled" && user.id === row.student_discord_id && row.student_admitted_at !== null;
  }

  // ---- helpers ------------------------------------------------------------------------------------------

  private rowOr404(id: string): AcademySessionRow {
    const row = SESSION_ID_RE.test(id) ? this.store.getSession(id) : undefined;
    if (!row) throw new HttpError(404, "NO_SESSION", "No session with that id");
    return row;
  }

  /** The booked host (or an owner) may start and grade it. */
  private runnable(id: string, user: UserRow): AcademySessionRow {
    const row = this.rowOr404(id);
    if (user.id !== row.host_discord_id && !config.discord.ownerIds.includes(user.id))
      throw new HttpError(403, "NOT_HOST", "This ATC24Academy session is booked for another host");
    return row;
  }

  private view(row: AcademySessionRow, host: boolean): AcademyView {
    const live = row.live_code ? this.sessions.get(row.live_code) : undefined;
    const v: AcademyView = {
      id: row.id,
      status: row.status,
      liveCode: live ? live.code : null,
      scheduledAt: new Date(row.scheduled_at).toISOString(),
      course: row.course_title,
      module: row.module_title,
      assessmentType: row.assessment_type,
      instructions: row.instructions,
      passingCriteria: row.passing_criteria,
      student: row.student_username,
      host: row.host_name,
      returnUrl: row.return_url,
      outcome: row.outcome,
    };
    if (!host) return v;
    const completed = this.store.eventsFor(row.id).find((e) => e.type === "session.completed");
    return {
      ...v,
      hostDiscordId: row.host_discord_id,
      inviteStatus: row.invite_status,
      inviteError: row.invite_error,
      resultDelivery: completed?.status ?? null,
    };
  }
}
