// Floating flight-plan readout (QF / FPL command).
import { radioCallsign, squawkFor } from "@sweatbox/shared";
import { Panel } from "../components/Panel";
import { useScope, type Widget } from "./store";

function FlightPlanWidget() {
  const selectedId = useScope((s) => s.selectedId);
  const ac = useScope((s) => s.aircraft.find((a) => a.id === selectedId));
  const strip = useScope((s) => (ac ? s.strips[ac.callsign] : undefined));
  if (!ac) return <div className="widget-body muted">Select an aircraft (click its tag).</div>;
  const fp = ac.fp;
  const radio = radioCallsign(ac.callsign);
  return (
    <div className="widget-body" style={{ width: 300 }}>
      <dl className="qf-grid">
        <dt>Callsign</dt>
        <dd>
          {ac.callsign}
          {radio && <span className="muted"> ({radio})</span>}
        </dd>
        <dt>Type</dt>
        <dd>
          {ac.type}/{ac.wake}
        </dd>
        <dt>Rules</dt>
        <dd>{fp?.flightRules ?? "-"}</dd>
        <dt>SSR</dt>
        <dd>{squawkFor(ac.callsign)}</dd>
        <dt>Route</dt>
        <dd>
          {fp?.departing ?? ac.dep ?? "----"} → {strip?.o_ades ?? fp?.arriving ?? ac.arr ?? "----"}
        </dd>
        <dt>RFL</dt>
        <dd>{fp?.flightLevel ?? "-"}</dd>
        <dt>SID</dt>
        <dd>{strip?.o_sid ?? fp?.sid ?? "-"}</dd>
        <dt>Filed</dt>
        <dd style={{ whiteSpace: "normal" }}>{fp?.route ?? "-"}</dd>
        {ac.dto?.fixList.length ? (
          <>
            <dt>Flying</dt>
            <dd style={{ whiteSpace: "normal" }}>{ac.dto.fixList.join(" ")}</dd>
          </>
        ) : null}
        {strip?.rmk && (
          <>
            <dt>Remark</dt>
            <dd>{strip.rmk}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function Widgets() {
  const widgets = useScope((s) => s.widgets);
  const close = (w: Widget) => useScope.getState().set({ widgets: useScope.getState().widgets.filter((x) => x.id !== w.id) });
  return (
    <>
      {widgets.map((w) => (
        <Panel key={w.id} id={`widget-${w.kind}`} title="Flight plan" defaultPos={{ x: window.innerWidth - 340, y: 72 }} onClose={() => close(w)}>
          <FlightPlanWidget />
        </Panel>
      ))}
    </>
  );
}
