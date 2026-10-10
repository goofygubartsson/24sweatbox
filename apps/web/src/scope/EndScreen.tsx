// End of a session: a short summary and the replay.
import { formatDuration, type SessionStats } from "@sweatbox/shared";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { toast } from "../components/Toast";

export const REPLAY_READY = "sweatbox:replay:ready";
export const REPLAY_DATA = "sweatbox:replay";

/** Open /replay in a new tab and post it the replay once it says it's ready (same origin only). */
export async function openReplayTab(code: string): Promise<void> {
  let replay: unknown;
  try {
    replay = await api.replay(code);
  } catch (e) {
    toast((e as Error).message, "error");
    return;
  }
  const w = window.open("/replay", "_blank");
  if (!w) {
    toast("The browser blocked the new tab. Download the replay and open it on the Replay page.", "error", 6000);
    return;
  }
  const onMsg = (e: MessageEvent) => {
    if (e.origin !== location.origin || e.source !== w || (e.data as { type?: string })?.type !== REPLAY_READY) return;
    w.postMessage({ type: REPLAY_DATA, replay }, location.origin);
    window.removeEventListener("message", onMsg);
  };
  window.addEventListener("message", onMsg);
  window.setTimeout(() => window.removeEventListener("message", onMsg), 60_000);
}

export function EndScreen({ stats, onClose }: { stats: SessionStats; onClose: () => void }) {
  const rows: [string, string | number][] = [
    ["Sweatbox", stats.scriptName ?? "-"],
    ["Duration", formatDuration(stats.wallSec)],
    ["Aircraft", stats.spawned],
    ["Landed", stats.landed],
    ["Separation losses", stats.separationLosses],
    ["Instructions", stats.hostInstructions],
  ];
  return (
    <Modal
      title="Session ended"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => navigate("/")}>
            Home
          </Button>
          <a className="btn" href={api.replayUrl(stats.code)} download={`sweatbox-${stats.code}.json`}>
            Download replay
          </a>
          <Button variant="primary" onClick={() => void openReplayTab(stats.code)}>
            View replay
          </Button>
        </>
      }
    >
      <dl className="summary">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
