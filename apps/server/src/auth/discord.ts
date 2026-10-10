// Discord API calls (spec 15.6). Never logs tokens or secrets.
import { config } from "@sweatbox/config";
import type { Env } from "../env";

const D = config.discord;

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface GuildMember {
  user: { id: string; username: string; global_name: string | null; avatar: string | null };
  nick: string | null;
  roles: string[];
}

/**
 * Result of a membership lookup. `transient` covers 429 / 5xx / network errors: callers must keep
 * the previous status in that case.
 */
export type MemberResult =
  | { kind: "member"; member: GuildMember }
  | { kind: "not_member" }
  | { kind: "unauthorized" }
  | { kind: "transient"; reason: string };

async function discordFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), D.requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class DiscordClient {
  constructor(private env: Env) {}

  get configured(): boolean {
    return Boolean(this.env.DISCORD_CLIENT_ID && this.env.DISCORD_CLIENT_SECRET && this.env.DISCORD_REDIRECT_URI);
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({
      client_id: this.env.DISCORD_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: D.scopes.join(" "),
      state,
      prompt: "none",
    });
    return `${D.authorizeUrl}?${q.toString()}`;
  }

  private async token(body: Record<string, string>): Promise<TokenSet | null> {
    const basic = Buffer.from(`${this.env.DISCORD_CLIENT_ID}:${this.env.DISCORD_CLIENT_SECRET}`).toString("base64");
    const res = await discordFetch(`${D.apiBase}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) return null;
    return (await res.json()) as TokenSet;
  }

  exchangeCode(code: string, redirectUri: string): Promise<TokenSet | null> {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<TokenSet | null> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async member(url: string, authorization: string): Promise<MemberResult> {
    let res: Response;
    try {
      res = await discordFetch(url, { headers: { Authorization: authorization } });
    } catch (e) {
      return { kind: "transient", reason: (e as Error).name };
    }
    if (res.status === 200) return { kind: "member", member: (await res.json()) as GuildMember };
    if (res.status === 404 || res.status === 403) return { kind: "not_member" };
    if (res.status === 401) return { kind: "unauthorized" };
    return { kind: "transient", reason: `HTTP ${res.status}` };
  }

  /** GET /users/@me/guilds/{guild}/member with the user's token. */
  memberWithUserToken(accessToken: string): Promise<MemberResult> {
    return this.member(`${D.apiBase}/users/@me/guilds/${D.guildId}/member`, `Bearer ${accessToken}`);
  }

  /** GET /guilds/{guild}/members/{user} with the bot token (periodic role checks). */
  memberWithBot(userId: string): Promise<MemberResult> {
    return this.member(`${D.apiBase}/guilds/${D.guildId}/members/${userId}`, `Bot ${this.env.DISCORD_BOT_TOKEN}`);
  }

  get canUseBot(): boolean {
    return Boolean(this.env.DISCORD_BOT_TOKEN) && config.features.botRoleCheck;
  }
}

/** Display name = nick ?? global_name ?? username, cut at " | ". */
export function displayNameOf(m: GuildMember): string {
  const raw = m.nick ?? m.user.global_name ?? m.user.username;
  return raw.split(D.nickSplit)[0]!.trim() || m.user.username;
}

export function isHostMember(m: GuildMember): boolean {
  return D.ownerIds.includes(m.user.id) || m.roles.some((r) => D.hostRoleIds.includes(r));
}

export function avatarUrl(id: string, avatar: string | null): string | null {
  return avatar ? `${D.cdnBase}/avatars/${id}/${avatar}.png?size=64` : null;
}
