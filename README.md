# ATC24Academy Sweatbox

A browser-based, multi-user ATC radar training simulator for the ATC24 / PTFS Roblox community.
A trainer picks an airport, a position and a runway format; the app generates the traffic
scenario (a *sweatbox*) and trainees join with a 6-letter code to work it on a radar scope.
Production: <https://sb.atc24academy.com>.

- **Server** (`apps/server`): Fastify + `ws`, authoritative simulation (airborne, approaches,
  departures and SIDs, holds, circuits, TWR clearances, full ground movement), Discord login,
  SQLite (accounts, tokens, archived replays).
- **Web** (`apps/web`): Vite + React 18 + Zustand. A deliberately plain interface: the start page,
  Create / Join Sweatbox, the radar scope with its control bar and flight strips, Replay and the
  Maker (trainers only).
- **Shared** (`packages/shared`): types and API contract, the `.sbx` script parser, the sweatbox
  generator, geometry, runway helpers, ground routing, data loaders. **Config**
  (`packages/config`): the zod schema for `sweatbox.config.ts` and its public subset.

> **Data status:** the spec's appendices (A and D) were cut off, so some reference data is
> derived or still missing: no fixes besides 4 SID fixes, no SIDs, no IPPH ground routing graph,
> and none of the 18 legacy scenarios. IRFD's taxi graph was traced from its ground artwork, so
> IRFD has full ground movement and DEL / GND sweatboxes. IRFD and IPPH runways use the exact thresholds from
> the ground-map spec. The other runways, coastlines, airspace and airport artwork were recovered
> from the old 24RC assets; IRFD's artwork is shifted onto its exact runways and carries the
> chart's hold bars, taxiway names and stand numbers. Everything that needs the
> missing data is implemented and tested against a synthetic airport. See [`data/README.md`](data/README.md) and
> [`spec/README.md`](spec/README.md) for how to drop the appendices in.

## Requirements

- Node.js 20.11+ (tested on 24)
- pnpm 9, through Corepack: `corepack enable`, or prefix every command with `corepack` (`corepack pnpm install`)

## Run it locally

```sh
pnpm install
cp .env.example .env        # optional for local development
pnpm dev                    # API on :3000, web on http://localhost:5173
```

`pnpm dev` runs in development mode: the home page shows **Dev host** / **Dev viewer** buttons, so
you don't need Discord. To log everyone in automatically, set `DEV_FAKE_USER=host` (or `viewer`)
in `.env`. Both only work with `NODE_ENV=development`.

Try it: **Dev host** → pick Airport, Position and Runway format → **Create Sweatbox** → **Play**.
User instructions are in [`docs/user-guide.md`](docs/user-guide.md).

## Discord login

1. Create an application at <https://discord.com/developers/applications>. Under OAuth2, add the
   redirect `https://sb.atc24academy.com/auth/callback` (and `http://localhost:5173/auth/callback`
   for development).
2. Put the client id and secret, the redirect URI and a random `SESSION_SIGNING_SECRET` in `.env`
   (see `.env.example`). Secrets live in `.env` only and are never sent to the browser or logged.
3. Optional: set `DISCORD_BOT_TOKEN` for a bot in the guild. Periodic role checks then use the bot,
   so hosts are never demoted because a user token expired.

Who can log in, and who is a host, is configured in `sweatbox.config.ts` (`discord.guildId`,
`hostRoleIds`, `ownerIds`).

## ATC24Academy integration

The ATC24Academy website books practical assessments here and receives signed pass / fail results.
Setup, the API, launch links, the callback outbox and key rotation are in
[docs/academy-integration.md](docs/academy-integration.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | API + web with reload |
| `pnpm build` | Build the server (`apps/server/dist`) and the web app (`apps/web/dist`) |
| `pnpm start` | Run the built server (`NODE_ENV=production`: needs the Discord settings in `.env`) |
| `pnpm serve` | Production server + web app on `127.0.0.1:3000`, restarted if it stops (for a tunnel) |
| `pnpm autostart` | Windows: start `pnpm serve` with Windows (see Deploy) |
| `pnpm test` | Unit and API tests (Vitest) in every package |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm e2e` | Playwright end-to-end tests (first run: `pnpm exec playwright install chromium`) |
| `pnpm academy keys` | New ATC24Academy API key and webhook secret (also `outbox`, `retry`: see the integration doc) |
| `pnpm data` | Rebuild `packages/shared/src/data/*.json` from `/data` (runs before dev, build and test) |

## Generated sweatboxes

Create Sweatbox and Session → Load sweatbox send `{ apt, position, runway }` to the server
(`POST /api/sessions` or `POST /api/sessions/:code/script` with a `generate` body). The server
builds the `.sbx` script with `packages/shared/src/generator.ts` and loads it immediately, named
`POS-APT-RWY` (for example `TWR-IRFD-25`). Traffic mix per position, duration, density and the
other knobs are in `generator` in `sweatbox.config.ts`. DEL and GND need the airport's ground map
and are refused (409, with the reason) where there is none. They start with every stand occupied
and refill freed stands (`parked: … stand=any`); GND runs at `rateByPosition.GND` times the normal
traffic, with arrivals spaced by `arrivalSpacingNm`. DEL files say `position = DEL`: a cleared departure is removed a
minute after its clearance (`ground.delRemoveAfterClearSec`). TWR also fills every stand where
there is a ground map, and nothing is spawned on a runway. Departures get a route of real fixes
toward their destination (`routeFixEveryNm`). Nothing moves or lands by itself: aircraft do what
the file and the controllers tell them.

## Configuration

Everything that isn't a secret is in **[`sweatbox.config.ts`](sweatbox.config.ts)**, typed and
commented: domain and ports, Discord guild and roles, session limits, every sim constant,
colours and design tokens, feature flags, rate limits and file paths. The server validates it at
startup and stops with a clear message if a value is wrong. The web app only gets the public
subset, baked in at build time (the build fails if browser code imports the full config).

`.env` holds secrets and per-machine overrides only: `DISCORD_*`, `SESSION_SIGNING_SECRET`,
`PORT`, `NODE_ENV`, plus `BIND_HOST`, `SERVE_WEB`, `DB_PATH`, `DEV_FAKE_USER` and the
ATC24Academy settings (`ACADEMY_*`).

## Deploy

**pm2 + Caddy** (the production setup):

```sh
pnpm install && pnpm build
rsync -a apps/web/dist/ /var/www/sweatbox/
pm2 start ecosystem.config.cjs && pm2 save
```

Then use [`deploy/Caddyfile`](deploy/Caddyfile). The API listens on `127.0.0.1:3000`. Caddy
serves the web app and proxies `/api/*` (including the `/api/ws` WebSocket) and `/auth/callback`.
Sessions live in memory, so run a single instance.

**Docker:** `docker build -t sweatbox .` then
`docker run -p 3000:3000 --env-file .env -v sweatbox-var:/app/var sweatbox`.
The container also serves the web app (`SERVE_WEB=1`). The Dockerfile has not been built in CI yet.

**Windows + Cloudflare Tunnel** (one machine, no Caddy):

```powershell
pnpm install
pnpm autostart                        # build, then start with Windows (asks for admin once)
winget install --id Cloudflare.cloudflared
pnpm autostart -TunnelToken <token>   # optional: cloudflared as a service too
```

`pnpm autostart` installs a Windows startup task ("ATC24Academy Sweatbox", runs as SYSTEM before
anyone logs in) that runs `scripts/serve.mjs`: the production server with the web app on
`http://127.0.0.1:3000` only, restarted if it stops, logging to `var/logs/sweatbox.log`. In the
Cloudflare Zero Trust dashboard, give the tunnel a public hostname (`sb.atc24academy.com`) with the
service `http://localhost:3000`; the WebSocket works through it. The Discord redirect
(`DISCORD_REDIRECT_URI`) and `app.publicUrl` must match that hostname.

| Command | |
|---|---|
| `pnpm autostart -Status` | Task state, health and the end of the log |
| `pnpm autostart -Restart` | Rebuild and restart (after changing code or `.env`) |
| `pnpm autostart -Stop` / `-Uninstall` | Stop it until the next boot / remove the task |
| `pnpm serve` | The same server in this terminal, without the task (`--build` rebuilds first) |

It takes port 3000, so stop it (`pnpm autostart -Stop`) before `pnpm dev`. If the folder is in
OneDrive, mark it "Always keep on this device" so the files are there before anyone logs in.

## Layout

```
sweatbox.config.ts        central config (non-secret)
data/                     reference data + sample scenarios (data/README.md)
scripts/build-data.ts     data -> packages/shared/src/data/*.json
packages/config           config schema, validation, public subset
packages/shared           API types (api.ts), script parser, geometry, runways, ground routing
apps/server               Fastify API, WebSocket, simulation (src/sim), auth
apps/web                  React app: scope (src/scope), pages, design system (src/styles)
e2e/                      Playwright tests
docs/user-guide.md        how trainers and trainees use it
docs/adding-an-airport.md how to add a ground map
deploy/Caddyfile          reverse proxy example
```

The REST and WebSocket contract is defined once, in
[`packages/shared/src/api.ts`](packages/shared/src/api.ts).

## Notes

- The legacy scenario path traversal is fixed: a scenario name must match `^[A-Za-z0-9-]+$`
  **and** appear in the directory listing before anything is read.
- Replays keep the documented `atc24academy-sweatbox-replay` v1 format, so old files still open
  in `/replay`.
- The server also accepts API requests whose `/api` prefix a proxy stripped (Caddy
  `handle_path`). If the Discord redirect is ever served the web app, it forwards itself to the API.
