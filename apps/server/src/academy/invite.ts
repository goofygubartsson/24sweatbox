// Host invitations for academy-booked sessions: a Discord direct message from the sweatbox bot.
// The booking also appears in the host's "ATC24Academy sessions" list on the home page.
import { config } from "@sweatbox/config";
import { isHostMember, type DiscordClient } from "../auth/discord";
import type { AcademySessionRow } from "./store";

export type InviteResult = { ok: true } | { ok: false; error: string };

export interface HostInviter {
  /** Invite the host to a booked session, or tell them it was cancelled. */
  notify(s: AcademySessionRow, kind: "invite" | "cancel"): Promise<InviteResult>;
}

/** Discord's <t:unix:F> renders the time in the reader's own timezone. */
const when = (ms: number) => `<t:${Math.floor(ms / 1000)}:F>`;

export function inviteText(s: AcademySessionRow, kind: "invite" | "cancel"): string {
  const what = `${s.course_title}: ${s.module_title}${s.assessment_type ? ` (${s.assessment_type})` : ""}`;
  if (kind === "cancel")
    return `Your ATC24Academy session on ${when(s.scheduled_at)} with ${s.student_username} has been cancelled.${s.cancel_reason ? `\nReason: ${s.cancel_reason}` : ""}\n${what}`;
  return [
    `You're booked to host an ATC24Academy practical on ${when(s.scheduled_at)}.`,
    `${what}, student ${s.student_username} (attempt ${s.attempt_number}).`,
    `Start it from "ATC24Academy sessions" on ${config.app.publicUrl}/ when it's time; the student's launch link brings them to your session.`,
  ].join("\n");
}

export class DiscordHostInviter implements HostInviter {
  constructor(private discord: DiscordClient) {}

  async notify(s: AcademySessionRow, kind: "invite" | "cancel"): Promise<InviteResult> {
    if (kind === "invite") {
      // only someone who can run the session gets invited
      const m = await this.discord.memberWithBot(s.host_discord_id);
      if (m.kind === "not_member") return { ok: false, error: "The host isn't a member of the ATC24Academy Discord" };
      if (m.kind === "unauthorized") return { ok: false, error: "Discord rejected the sweatbox's bot token" };
      if (m.kind === "transient") return { ok: false, error: `Discord didn't answer the host check (${m.reason}); retry shortly` };
      if (!isHostMember(m.member)) return { ok: false, error: "The host doesn't have the sweatbox host role" };
    }
    const r = await this.discord.sendDm(s.host_discord_id, inviteText(s, kind));
    return r.ok ? { ok: true } : { ok: false, error: r.reason };
  }
}
