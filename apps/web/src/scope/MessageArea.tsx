import cfg from "@sweatbox/config/public";
import { formatClock } from "@sweatbox/shared";
import type { Message } from "./store";

const colour = (level: Message["level"]): string => {
  const L = cfg.colours.log;
  if (level === "local") return cfg.colours.theme.muted;
  if (level === "error-local") return L.error;
  return L[level];
};

/** Bottom-left session log + feedback for the host's own commands. */
export function MessageArea({ messages, lines = cfg.ui.messageLines }: { messages: Message[]; lines?: number }) {
  const shown = messages.slice(-lines);
  return (
    <div className="msgs" role="log" aria-label="Session messages">
      {shown.map((m) => (
        <div key={m.id} className="msgs__line" style={{ color: colour(m.level) }}>
          {m.atSec !== undefined && <span className="msgs__time">{formatClock(m.atSec)}</span>}
          {m.text}
        </div>
      ))}
    </div>
  );
}
