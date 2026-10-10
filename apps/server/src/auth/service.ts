// Accounts, auth sessions (cookie / bearer tokens) and the periodic host-role re-check.
import { config } from "@sweatbox/config";
import type { Me } from "@sweatbox/shared";
import type { Store, UserRow } from "../db";
import type { Env } from "../env";
import { randomToken, sha256, type Secrets } from "../crypto";
import { avatarUrl, displayNameOf, isHostMember, type DiscordClient, type GuildMember, type TokenSet } from "./discord";

const RECHECK_MS = config.discord.roleRecheckMinutes * 60_000;
const COOKIE_TTL_MS = config.auth.cookieMaxAgeDays * 86_400_000;
/** After a transient Discord failure, wait this long before trying again. */
const TRANSIENT_BACKOFF_MS = 30_000;

export class AuthService {
  private inflight = new Map<string, Promise<UserRow>>();
  private backoffUntil = new Map<string, number>();

  constructor(
    private store: Store,
    private env: Env,
    private discord: DiscordClient,
    private secrets: Secrets,
  ) {}

  // ---- auth sessions -----------------------------------------------------------------------------------

  createSession(userId: string): string {
    const token = randomToken(32);
    this.store.createAuthSession(sha256(token), userId, COOKIE_TTL_MS);
    return token;
  }

  userForToken(token: string | undefined | null): UserRow | undefined {
    if (!token) return undefined;
    const id = this.store.getAuthSession(sha256(token));
    return id ? this.store.getUser(id) : undefined;
  }

  logout(token: string | undefined | null): void {
    if (token) this.store.deleteAuthSession(sha256(token));
  }

  toMe(u: UserRow): Me {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      avatarUrl: u.avatar,
      isHost: Boolean(u.is_host),
      reauth: Boolean(u.reauth),
    };
  }

  // ---- Discord login -----------------------------------------------------------------------------------

  private tokenFields(t: TokenSet) {
    return {
      access_token: this.secrets.encrypt(t.access_token),
      refresh_token: this.secrets.encrypt(t.refresh_token),
      token_expires_at: Date.now() + t.expires_in * 1000,
    };
  }

  private memberFields(m: GuildMember) {
    return {
      username: m.user.username,
      display_name: displayNameOf(m),
      avatar: avatarUrl(m.user.id, m.user.avatar),
      is_host: isHostMember(m) ? 1 : 0,
      in_guild: 1,
      reauth: 0,
      roles_checked_at: Date.now(),
    };
  }

  /** OAuth callback: exchange the code, check the guild, upsert the user, return a new session token. */
  async completeLogin(code: string, redirectUri: string): Promise<{ ok: true; token: string; user: UserRow } | { ok: false; reason: "not_in_guild" | "discord_error" }> {
    let tokens: TokenSet | null;
    try {
      tokens = await this.discord.exchangeCode(code, redirectUri);
    } catch {
      return { ok: false, reason: "discord_error" };
    }
    if (!tokens) return { ok: false, reason: "discord_error" };
    const r = await this.discord.memberWithUserToken(tokens.access_token);
    if (r.kind === "not_member") return { ok: false, reason: "not_in_guild" };
    if (r.kind !== "member") return { ok: false, reason: "discord_error" };
    const m = r.member;
    this.store.upsertUser({ id: m.user.id, ...this.memberFields(m), ...this.tokenFields(tokens) });
    const user = this.store.getUser(m.user.id)!;
    return { ok: true, token: this.createSession(user.id), user };
  }

  // ---- development logins ------------------------------------------------------------------------------

  devUser(as: "host" | "viewer", name: string): UserRow {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "dev";
    const id = `dev-${as}-${slug}`;
    this.store.upsertUser({
      id,
      username: slug,
      display_name: name,
      avatar: null,
      is_host: as === "host" ? 1 : 0,
      reauth: 0,
      in_guild: 1,
      roles_checked_at: Date.now(),
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
    });
    return this.store.getUser(id)!;
  }

  /** DEV_FAKE_USER bypass (development only). */
  fakeUser(): UserRow | undefined {
    if (!this.env.isDev || !this.env.DEV_FAKE_USER) return undefined;
    return this.devUser(this.env.DEV_FAKE_USER, this.env.DEV_FAKE_USER === "host" ? "Dev Host" : "Dev Viewer");
  }

  // ---- role re-check -----------------------------------------------------------------------------------

  /** Re-check membership / host role when older than roleRecheckMinutes (or when forced). */
  ensureFresh(user: UserRow, force = false): Promise<UserRow> {
    if (user.id.startsWith("dev-")) return Promise.resolve(user);
    const stale = Date.now() - user.roles_checked_at >= RECHECK_MS;
    if ((!stale && !force) || (this.backoffUntil.get(user.id) ?? 0) > Date.now()) return Promise.resolve(user);
    const running = this.inflight.get(user.id);
    if (running) return running;
    const p = this.recheck(user)
      .catch(() => user)
      .finally(() => this.inflight.delete(user.id));
    this.inflight.set(user.id, p);
    return p;
  }

  private async recheck(user: UserRow): Promise<UserRow> {
    if (this.discord.canUseBot) {
      const r = await this.discord.memberWithBot(user.id);
      if (r.kind === "member" || r.kind === "not_member") return this.apply(user, r.kind === "member" ? r.member : null);
      if (r.kind === "transient") return this.transient(user);
      // bot token rejected: fall back to the user's token
    }
    let access = this.secrets.decrypt(user.access_token);
    if (!access || (user.token_expires_at ?? 0) < Date.now() + 60_000) access = await this.refreshTokens(user);
    if (!access) return this.demoteReauth(user);
    let r = await this.discord.memberWithUserToken(access);
    if (r.kind === "unauthorized") {
      access = await this.refreshTokens(user);
      if (!access) return this.demoteReauth(user);
      r = await this.discord.memberWithUserToken(access);
    }
    if (r.kind === "member") return this.apply(user, r.member);
    if (r.kind === "not_member") return this.apply(user, null);
    if (r.kind === "unauthorized") return this.demoteReauth(user);
    return this.transient(user);
  }

  /** New access token, or null when the refresh token is dead. Network trouble throws (keeps status). */
  private async refreshTokens(user: UserRow): Promise<string | null> {
    const rt = this.secrets.decrypt(user.refresh_token);
    if (!rt) return null;
    const t = await this.discord.refresh(rt);
    if (!t) return null;
    this.store.updateUser(user.id, this.tokenFields(t));
    return t.access_token;
  }

  private apply(user: UserRow, m: GuildMember | null): UserRow {
    if (m) this.store.updateUser(user.id, this.memberFields(m));
    else this.store.updateUser(user.id, { is_host: 0, in_guild: 0, roles_checked_at: Date.now() });
    return this.store.getUser(user.id)!;
  }

  private demoteReauth(user: UserRow): UserRow {
    this.store.updateUser(user.id, { is_host: 0, reauth: 1, roles_checked_at: Date.now() });
    return this.store.getUser(user.id)!;
  }

  /** 429 / 5xx / network: never demote, just try again a bit later. */
  private transient(user: UserRow): UserRow {
    this.backoffUntil.set(user.id, Date.now() + TRANSIENT_BACKOFF_MS);
    return user;
  }
}
