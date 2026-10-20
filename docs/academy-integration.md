# ATC24Academy integration

The ATC24Academy training website books practical sessions on the sweatbox for its students and
receives the verified result when a session finishes. The code is in `apps/server/src/academy`.

```
Academy: POST /api/v1/sessions             -> the sweatbox books the session and DMs the host
Student: opens the launch URL              -> logs in with Discord, waits for the host or joins
Host:    Start (home page) ... Record result -> the session ends
Sweatbox: POST <ACADEMY_BASE_URL>/api/integrations/sweatbox/callback   (signed session.completed)
```

Only the signed callback counts as a result. A student coming back to the academy never does.

## Setup

1. Generate the secrets:

   ```
   pnpm academy keys          # production build: node apps/server/dist/cli.js keys
   ```

   This prints the sweatbox's `.env` lines (`ACADEMY_API_KEY_HASH`, `ACADEMY_WEBHOOK_SECRET`) and
   the academy's (`SWEATBOX_API_KEY`, `SWEATBOX_WEBHOOK_SECRET`). The raw API key is shown only
   there; the sweatbox stores only its SHA-256 hash.

2. Sweatbox `.env`:

   | Variable | Value |
   |---|---|
   | `ACADEMY_BASE_URL` | `https://atc24academy.com`. The only origin allowed for `callbackUrl` (and `returnUrl`). Empty turns the integration off (the API then answers 503). |
   | `ACADEMY_API_KEY_HASH` | SHA-256 hex of the API key. Comma-separate two while rotating. |
   | `ACADEMY_WEBHOOK_SECRET` | Shared with the academy; signs callbacks. At least 32 characters. |
   | `ACADEMY_LAUNCH_TOKEN_TTL_SECONDS` | Lifetime of one-time launch links, 30-300 (default 300). |

   `DISCORD_BOT_TOKEN` must be set for host invitations: the bot must be in the ATC24Academy
   guild and hosts must accept direct messages from its members.

3. Academy `.env`:

   ```
   SWEATBOX_API_URL=https://sb.atc24academy.com/api
   SWEATBOX_API_KEY=<from pnpm academy keys>
   SWEATBOX_WEBHOOK_SECRET=<from pnpm academy keys>
   SWEATBOX_LAUNCH_TOKENS=true
   SWEATBOX_TIMEOUT_MS=10000
   ```

Non-secret settings (invite wait, replay retention, retry schedule, rate limits) are under
`academy` in `sweatbox.config.ts`.

## The academy's API

All three endpoints take `Authorization: Bearer <API key>` (missing or wrong: `401`) and answer
errors as `{ "error": { "message": "..." } }`. They are rate-limited per client IP
(`academy.requestsPerMin`).

| Endpoint | Behaviour |
|---|---|
| `POST /api/v1/sessions` | Books the session. `Idempotency-Key` must equal `reference`. Answers `201` with `sessionId`, `launchUrl` (`https://sb.atc24academy.com/join/<token>`, valid until the session ends), `status` and `hostInvite`. The same key again returns the same session with `200` and retries a failed invitation. The same key with a different body is `409`. A `callbackUrl` or `returnUrl` outside `ACADEMY_BASE_URL` is `422`, as is any invalid field. |
| `POST /api/v1/sessions/{id}/cancel` | Cancels the booking, revokes every launch link, ends a running session and tells the host. Repeats answer `200` with no side effects; a completed session is `409`; an unknown one `404`. |
| `POST /api/v1/sessions/{id}/launch-tokens` | One-time launch link (`/join?token=…`) for `studentDiscordId`, valid for `ACADEMY_LAUNCH_TOKEN_TTL_SECONDS`. Another student is `403`; a cancelled or completed session `409`. |

**Host invitation.** The bot checks that the host is in the guild with the host role, then sends a
direct message with the time (in the host's own timezone), the course and the student. If Discord
takes longer than `academy.hostInviteWaitMs`, the answer is `"pending"` and the invitation finishes
in the background. Failures are reported as `"failed"` with the reason.

## Students and hosts

- **Student.** The launch URL asks them to log in with Discord. Only the account whose ID is
  `student.discordId` gets in; anyone else is told to switch accounts. They then wait on
  `/academy/<id>` (instructions, passing criteria, time) until the host starts the session, and are
  taken into it automatically. Links for cancelled or finished sessions show a message with
  **Return to ATC24Academy** (`returnUrl`, exactly as received). The same link is on the end screen.
- **Host.** Bookings appear under **ATC24Academy sessions** on the home page; **Start** opens an
  ordinary sweatbox session linked to the booking (load a sweatbox from **Session** as usual). Only
  the hosts and the booked student, after using a launch link, can join it or see its replay. The
  session ends with **Session → Record result and end** (pass or fail, optional score and
  feedback), not with the usual End button. Only the booked host or an owner can start and grade it.

## Callbacks

Results go out through a persistent outbox (`academy_outbox`, checked every
`academy.outboxPollSec`):

- `session.completed`, exactly once per completed session (a unique index enforces it) and never
  for a cancelled one. `replayUrl` is `https://sb.atc24academy.com/replay?code=<code>` when the
  session ran; replays of academy sessions are kept for `academy.replayRetentionDays`.
- `replay.failed` (with `replayUrl: null`) if a session ran but its replay couldn't be saved.

Every attempt is signed with a fresh timestamp: `X-Sweatbox-Timestamp` (unix seconds) and
`X-Sweatbox-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`. The body and its
`eventId` never change between attempts.

| Academy answer | Outbox |
|---|---|
| 2xx | delivered |
| 429, 5xx, 408, network error | retried after 30 s, doubling up to 1 h, for 48 h; then failed |
| 401, 400, 413, 422, anything else | failed at once |

A failed callback is logged as `[academy] callback ... needs staff`, shows as "delivery failed" in
the host's list and keeps its row. Fix the cause (for a 401: the shared secret or the server clock,
which must be NTP-synced because the academy allows 300 s of skew), then:

```
pnpm academy outbox failed       # list them
pnpm academy retry <eventId>     # or: pnpm academy retry failed
```

## Operator notes

- **Callback URL:** `https://atc24academy.com/api/integrations/sweatbox/callback`.
- **Source IPs:** callbacks come from the sweatbox server's own public address. There is no fixed
  list; if the academy filters by IP, allow that server's egress address (on the server:
  `curl -4 https://ifconfig.me`).
- **Rotating the API key:** run `pnpm academy keys` and take the new `SWEATBOX_API_KEY` and its
  hash. Set `ACADEMY_API_KEY_HASH=<new hash>,<old hash>` on the sweatbox and restart, switch the
  academy to the new key, then remove the old hash and restart again.
- **Rotating the webhook secret:** the sweatbox signs with one secret, so change
  `ACADEMY_WEBHOOK_SECRET` (sweatbox) and `SWEATBOX_WEBHOOK_SECRET` (academy) together. Callbacks
  rejected with 401 in between are kept; run `pnpm academy retry failed` afterwards.
- **Audit:** `academy_audit` records bookings, invitations (and their failures), cancellations,
  launches (including wrong-account attempts), results and every delivery attempt. API keys,
  secrets and launch tokens are never logged; launch tokens are stored as hashes, plus the
  session's own link encrypted with `SESSION_SIGNING_SECRET` so a retried booking returns the same
  URL.
- **Proxies:** `/join/…` and `/academy/…` are web-app pages; `/api/v1/…` and `/api/academy/…`
  are API routes, which the Caddyfile already sends to the server.
