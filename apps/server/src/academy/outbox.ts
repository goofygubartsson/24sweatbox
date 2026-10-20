// The persistent callback outbox: signed POSTs of results to the academy, retried with backoff.
// Rows live in academy_outbox, so results survive restarts and academy outages.
import { config } from "@sweatbox/config";
import { signCallback } from "./signing";
import type { AcademyStore, OutboxRow } from "./store";

const A = config.academy;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface OutboxOptions {
  /** Shared webhook secret (ACADEMY_WEBHOOK_SECRET); nothing is sent without it. */
  secret: string;
  /** Only this origin may receive callbacks (ACADEMY_BASE_URL). */
  origin: string | null;
  fetch?: FetchFn;
  now?: () => number;
  /** Staff alerts (callbacks that need a person); defaults to the server log. */
  alert?: (message: string) => void;
}

/** Delay before retry number `attempt` (1 = first retry): base * 2^(n-1), capped. */
export const retryDelaySec = (attempt: number): number => Math.min(A.retryMaxSec, A.retryBaseSec * 2 ** Math.max(0, attempt - 1));

type Verdict = { kind: "delivered" } | { kind: "retry"; error: string } | { kind: "stop"; error: string };

function verdict(status: number, text: string): Verdict {
  if (status >= 200 && status < 300) return { kind: "delivered" };
  const why = text.slice(0, 300);
  if (status === 401) return { kind: "stop", error: `401: the academy rejected the signature or timestamp (check ACADEMY_WEBHOOK_SECRET and the server clock) ${why}`.trim() };
  if (status === 400 || status === 413 || status === 422) return { kind: "stop", error: `${status}: the academy rejected the event ${why}`.trim() };
  if (status === 408 || status === 429 || status >= 500) return { kind: "retry", error: `${status} ${why}`.trim() };
  return { kind: "stop", error: `${status}: unexpected answer from the academy ${why}`.trim() };
}

export class CallbackOutbox {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private fetchFn: FetchFn;
  private now: () => number;
  private alert: (message: string) => void;

  constructor(
    private store: AcademyStore,
    private opts: OutboxOptions,
  ) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.alert = opts.alert ?? ((m) => console.error(`[academy] ${m}`));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), A.outboxPollSec * 1000);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Deliver soon (a new event was queued). */
  kick(): void {
    if (this.timer) setImmediate(() => void this.runOnce());
  }

  /** Send every due event once; overlapping calls share one pass. */
  runOnce(): Promise<void> {
    if (!this.running) this.running = this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<void> {
    if (!this.opts.secret) return;
    for (const row of this.store.dueEvents(this.now())) await this.deliver(row);
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const attempt = row.attempts + 1;
    const url = new URL(row.url);
    if (!this.opts.origin || url.origin !== this.opts.origin) {
      return this.finish(row, attempt, null, { kind: "stop", error: "The callback URL is not on ACADEMY_BASE_URL" });
    }
    // a fresh timestamp and signature on every attempt; the body (and its eventId) never changes
    const ts = Math.floor(this.now() / 1000).toString();
    let status: number | null = null;
    let v: Verdict;
    try {
      const res = await this.fetchFn(row.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sweatbox-Timestamp": ts, "X-Sweatbox-Signature": signCallback(this.opts.secret, ts, row.body) },
        body: row.body,
        redirect: "manual",
        signal: AbortSignal.timeout(A.callbackTimeoutMs),
      });
      status = res.status;
      v = verdict(res.status, await res.text().catch(() => ""));
    } catch (e) {
      v = { kind: "retry", error: `network: ${(e as Error).name}: ${(e as Error).message}`.slice(0, 300) };
    }
    this.finish(row, attempt, status, v);
  }

  private finish(row: OutboxRow, attempt: number, status: number | null, v: Verdict): void {
    const now = this.now();
    const tag = `${row.type} ${row.event_id} for ${row.session_id}`;
    if (v.kind === "delivered") {
      this.store.updateEvent(row.event_id, { status: "delivered", attempts: attempt, last_status: status, last_error: null, delivered_at: now });
      this.store.audit(row.session_id, "callback_delivered", `${tag}, attempt ${attempt}, HTTP ${status}`);
      return;
    }
    const expired = now - row.created_at >= A.retryForHours * 3_600_000;
    if (v.kind === "retry" && !expired) {
      const next = now + retryDelaySec(attempt) * 1000;
      this.store.updateEvent(row.event_id, { attempts: attempt, last_status: status, last_error: v.error, next_attempt_at: next });
      this.store.audit(row.session_id, "callback_retry", `${tag}, attempt ${attempt}: ${v.error}`);
      return;
    }
    const error = v.kind === "retry" ? `gave up after ${A.retryForHours} h: ${v.error}` : v.error;
    this.store.updateEvent(row.event_id, { status: "failed", attempts: attempt, last_status: status, last_error: error });
    this.store.audit(row.session_id, "callback_failed", `${tag}, attempt ${attempt}: ${error}`);
    this.alert(`callback ${tag} needs staff: ${error}. Fix it, then run \`pnpm academy retry ${row.event_id}\`.`);
  }
}
