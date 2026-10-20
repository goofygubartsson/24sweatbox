// Session panel (trainers): clock, load a generated sweatbox, TWR mode, who is connected, end.
import { useState } from "react";
import type { AcademyView } from "@sweatbox/shared";
import { ResultModal } from "../components/Academy";
import cfg from "@sweatbox/config/public";
import { formatClock, formatDuration, type GenerateSpec } from "@sweatbox/shared";
import { api } from "../lib/api";
import { Button } from "../components/Button";
import { GenerateForm } from "../components/GenerateForm";
import { useScope } from "./store";
import { act } from "./hostbar/act";

/** `academy`: the ATC24Academy assessment this session runs; it ends by recording the result. */
export function HostPanel({ code, academy, onAcademy }: { code: string; academy?: AcademyView | null; onAcademy?: (v: AcademyView) => void }) {
  const snap = useScope((s) => s.snap);
  const [grading, setGrading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (spec: GenerateSpec) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.loadScript(code, { generate: spec });
      useScope.getState().say(`Loaded ${r.scriptName} (${r.commandCount} commands)`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!snap) return null;
  return (
    <aside className="hostpanel" aria-label="Session">
      <section>
        <h3>Session {code}</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {snap.scriptName ?? "Nothing loaded"} · {formatClock(snap.elapsedSec)} · {snap.aircraft.length} aircraft
        </span>
        <div className="row">
          <Button variant={snap.running ? "secondary" : "primary"} disabled={snap.ended || !snap.scriptName} onClick={() => void act(() => api.clock(code, { action: snap.running ? "pause" : "play" }))}>
            {snap.running ? "Pause" : "Play"}
          </Button>
          <label className="muted" htmlFor="speed" style={{ fontSize: 12 }}>
            Speed
          </label>
          <input
            id="speed"
            type="range"
            min={cfg.session.minSpeed}
            max={cfg.session.maxSpeed}
            value={snap.speed}
            onChange={(e) => void act(() => api.clock(code, { speed: Number(e.target.value) }))}
            style={{ flex: 1, accentColor: cfg.colours.theme.muted }}
          />
          <span className="data" style={{ width: 24 }}>
            {snap.speed}×
          </span>
        </div>
        <label className="check">
          <input type="checkbox" checked={snap.twr} onChange={(e) => void act(() => api.twr(code, e.target.checked))} />
          Arrivals need a landing clearance (TWR)
        </label>
      </section>

      <section>
        <h3>Load sweatbox</h3>
        <GenerateForm submitLabel="Load sweatbox" busy={busy} error={error} onSubmit={(spec) => void load(spec)} />
      </section>

      {(snap.clients?.length ?? 0) > 0 && (
        <section>
          <h3>Connected</h3>
          <ul className="clients">
            {(snap.clients ?? []).map((c) => (
              <li key={c.user}>
                <span className="grow">
                  {c.name}
                  {c.host && <span className="muted"> · trainer</span>}
                </span>
                <span className="muted">{formatDuration(c.connectedSec)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {snap.academyId ? (
        <section>
          <h3>ATC24Academy assessment</h3>
          {academy && (
            <span className="muted" style={{ fontSize: 12 }}>
              {academy.student} · {academy.course}: {academy.module}
              {academy.outcome && ` · ${academy.outcome}`}
            </span>
          )}
          {academy?.instructions && <p className="academy-note">{academy.instructions}</p>}
          <Button variant="danger" disabled={!academy || academy.status !== "reserved"} onClick={() => setGrading(true)}>
            Record result and end
          </Button>
          {grading && academy && (
            <ResultModal
              view={academy}
              onClose={() => setGrading(false)}
              onDone={(v) => {
                setGrading(false);
                onAcademy?.(v);
              }}
            />
          )}
        </section>
      ) : (
        <section>
          <Button variant="danger" confirm="Click again to end the session" disabled={snap.ended} onClick={() => void act(() => api.end(code))}>
            End session
          </Button>
        </section>
      )}
    </aside>
  );
}
