// The one compact top bar: UTC clock, station, session code, sweatbox, time, speed, play/pause and,
// for trainers, the selected aircraft's controls.
import { useEffect, useState } from "react";
import { formatClock, formatUtc, type Me } from "@sweatbox/shared";
import { api } from "../../lib/api";
import { Link } from "../../lib/router";
import { toast } from "../../components/Toast";
import { ListPopup } from "../../components/ListPopup";
import { useScope } from "../store";
import { stationLabel } from "../views";
import { act } from "./act";
import { AirControls, BarField } from "./AirControls";
import { GroundControls } from "./GroundControls";

function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="bar__item bar__value">{formatUtc(now)}</span>;
}

export function HostBar({ me, code }: { me: Me | null; code: string }) {
  const snap = useScope((s) => s.snap);
  const apt = useScope((s) => s.apt);
  const mode = useScope((s) => s.mode);
  const socket = useScope((s) => s.socket);
  const aircraft = useScope((s) => s.aircraft);
  const selectedId = useScope((s) => s.selectedId);
  const hostPanel = useScope((s) => s.hostPanel);
  const [aselAnchor, setAselAnchor] = useState<DOMRect | null>(null);
  const isHost = Boolean(me?.isHost);
  const sel = aircraft.find((a) => a.id === selectedId);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast(`Session code ${code} copied`);
    } catch {
      toast(`Session code: ${code}`);
    }
  };

  return (
    <header className="bar" role="toolbar" aria-label="Scope bar">
      <Link to="/" className="bar__item bar__home" title="Back to the start">
        Sweatbox
      </Link>
      <span className="bar__sep" />
      <UtcClock />
      <span className="bar__item">{stationLabel(apt, mode)}</span>
      <button type="button" className="bar__item bar__code" onClick={() => void copyCode()} title="Copy the session code">
        {code}
      </button>
      {snap && socket !== "open" && <span className="bar__item muted">{socket === "polling" ? "Slow connection" : "Reconnecting…"}</span>}
      {snap && (
        <>
          <span className="bar__item" title="Sweatbox">
            {snap.scriptName ?? "Nothing loaded"}
          </span>
          <span className="bar__item bar__value" title="Sweatbox time">
            {formatClock(snap.elapsedSec)}
          </span>
          <span className="bar__item bar__value" title="Speed">
            {snap.speed}×
          </span>
          {snap.twr && <span className="bar__item muted">TWR</span>}
          {isHost && !snap.ended && snap.scriptName && (
            <BarField k={snap.running ? "Pause" : "Play"} on={snap.running} onClick={() => void act(() => api.clock(code, { action: snap.running ? "pause" : "play" }))} />
          )}
          {snap.ended && <span className="bar__item muted">Ended</span>}
        </>
      )}
      <span className="bar__sep" />
      <BarField
        k="ASEL"
        v={sel ? `${sel.callsign} ${sel.type} ${sel.dep ?? "----"}→${sel.arr ?? "----"}` : "none"}
        onClick={(r) => setAselAnchor(aselAnchor ? null : r)}
        title="Selected aircraft (or click a tag)"
      />
      {isHost &&
        sel?.dto &&
        !snap?.ended &&
        (sel.dto.onGround && sel.dto.gnd ? <GroundControls code={code} ac={{ ...sel, dto: sel.dto }} /> : !sel.dto.onGround ? <AirControls code={code} ac={{ ...sel, dto: sel.dto }} /> : null)}
      <span className="bar__spacer" />
      {isHost && <BarField k="Session" on={hostPanel} onClick={() => useScope.getState().set({ hostPanel: !hostPanel })} />}
      {me && <span className="bar__item muted">{me.displayName}</span>}
      {aselAnchor && (
        <ListPopup
          anchor={aselAnchor}
          filter
          placeholder="Callsign"
          items={[...aircraft]
            .sort((a, b) => a.callsign.localeCompare(b.callsign))
            .map((a) => ({ value: a.id, label: a.callsign, hint: `${a.type} ${a.dep ?? "----"}→${a.arr ?? "----"}`, text: a.callsign }))}
          initial={selectedId ?? undefined}
          onPick={(id) => {
            useScope.getState().select(id);
            setAselAnchor(null);
          }}
          onClose={() => setAselAnchor(null)}
          width={280}
        />
      )}
    </header>
  );
}
