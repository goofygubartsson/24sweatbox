// GND / TWR flight lists. Strip edits are shared with everyone in the session (server strips).
import { useState } from "react";
import cfg from "@sweatbox/config/public";
import { expandRoute, sids, squawkFor, type Strips } from "@sweatbox/shared";
import { api } from "../lib/api";
import { Panel } from "../components/Panel";
import { useScope } from "./store";
import { act } from "./hostbar/act";
import { runwayChoices } from "./commands";
import type { RAircraft } from "./model";

const MAX = cfg.limits.stripValueMax;

function Cell({ value, onSave, placeholder, width }: { value: string; onSave: (v: string) => void; placeholder: string; width?: number }) {
  const [edit, setEdit] = useState(false);
  if (edit)
    return (
      <input
        className="field strip-input"
        style={{ width }}
        autoFocus
        defaultValue={value}
        maxLength={MAX}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            onSave((e.target as HTMLInputElement).value);
            setEdit(false);
          }
          if (e.key === "Escape") setEdit(false);
        }}
        onBlur={(e) => {
          if (e.target.value !== value) onSave(e.target.value);
          setEdit(false);
        }}
      />
    );
  return (
    <button type="button" className={`strip-cell${value ? "" : " strip-cell--empty"}`} onClick={() => setEdit(true)}>
      {value || placeholder}
    </button>
  );
}

/**
 * Departure clearance / status for the C column: empty until cleared, then where the aircraft is in
 * its departure (cleared on stand, pushing, taxiing, holding, lining up, departing, airborne).
 */
export function departureStatus(a: RAircraft, cleared: boolean): { text: string; title: string } {
  if (!cleared) return { text: "", title: "Not cleared: click to give the clearance" };
  const g = a.dto?.gnd;
  if (!a.onGround || !g) return { text: "AIR", title: "Airborne" };
  switch (g.mode) {
    case "stand":
      return { text: "CLR", title: `Cleared, on stand${g.status.includes("WAITING") ? ` (${g.status.split(", ").slice(1).join(", ")})` : ""}` };
    case "push":
      return { text: "PUSH", title: g.status };
    case "taxi":
    case "follow":
      return { text: g.paused ? "HOLD" : "TAXI", title: g.status };
    case "holding":
      return { text: "HOLD", title: g.status };
    case "lineup":
    case "lined":
      return { text: "LU", title: g.status };
    case "takeoff":
      return { text: "DEP", title: g.status };
    default:
      return { text: "CLR", title: g.status };
  }
}

function sidOptions(apt: string): string[] {
  return ["VIS", ...Object.keys(sids[apt] ?? {}).sort()];
}

function StripTable({ list, kind, code }: { list: RAircraft[]; kind: "dep" | "arr"; code: string | null }) {
  const strips = useScope((s) => s.strips);
  const selectedId = useScope((s) => s.selectedId);
  const apt = useScope((s) => s.apt)!;
  const set = (cs: string, key: string, value: string) => {
    if (!code) return useScope.getState().say("Strips are shared only in a session", "error-local");
    void act(() => api.strip(code, cs, key, value));
  };
  const s = (cs: string): Strips[string] => strips[cs] ?? {};
  const depRunway = runwayChoices(apt, "dep")[0] ?? null;
  return (
    <div className="strips">
      <table>
        <thead>
          <tr>
            <th>CS</th>
            <th>TYPE</th>
            <th>SSR</th>
            <th>STAND</th>
            {kind === "dep" && <th>SID</th>}
            {kind === "dep" && <th>CLMB</th>}
            <th>ADES</th>
            <th>RMK</th>
            {kind === "arr" && <th title="Deleted">DEL</th>}
            <th title={kind === "dep" ? "Clearance and departure status" : "Cleared"}>C</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => {
            const st = s(a.callsign);
            const sid = st.o_sid ?? a.fp?.sid ?? "";
            const routeText = (() => {
              if (!a.fp) return "";
              const r = expandRoute(sid && sid !== "VIS" ? `${sid} ${a.fp.route}` : a.fp.route, { dep: a.fp.departing, arr: a.fp.arriving, runway: a.dto?.gnd?.rwy ?? depRunway });
              return r.heading !== null ? `HDG ${r.heading}` : r.points.map((p) => p.name).join(" ") || a.fp.route;
            })();
            return (
              <tr
                key={a.id}
                aria-selected={a.id === selectedId}
                style={kind === "arr" && st.del ? { textDecoration: "line-through", opacity: 0.5 } : undefined}
              >
                <td className="strip-cs" onClick={() => useScope.getState().select(a.id)}>
                  {a.callsign}
                </td>
                <td>
                  <Cell value={st.o_atyp ?? a.type} placeholder="----" onSave={(v) => set(a.callsign, "o_atyp", v === a.type ? "" : v)} width={52} />
                </td>
                <td className="data">{squawkFor(a.callsign)}</td>
                <td>
                  <Cell value={st.stand ?? st.o_stand ?? a.dto?.gnd?.stand ?? ""} placeholder="--" onSave={(v) => set(a.callsign, "stand", v)} width={44} />
                </td>
                {kind === "dep" && (
                  <td
                    title={routeText}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      useScope.getState().toggleRoute(a.callsign);
                    }}
                  >
                    <select
                      className="field strip-input"
                      style={{ width: 92 }}
                      value={sid}
                      onChange={(e) => set(a.callsign, "o_sid", e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label={`SID for ${a.callsign}`}
                    >
                      <option value="">--</option>
                      {sidOptions(apt).map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                      {sid && !sidOptions(apt).includes(sid) && <option>{sid}</option>}
                    </select>
                  </td>
                )}
                {kind === "dep" && (
                  <td>
                    <Cell value={st.o_clmb ?? st.clmb ?? ""} placeholder="----" onSave={(v) => set(a.callsign, "clmb", v)} width={52} />
                  </td>
                )}
                <td>
                  <Cell value={st.o_ades ?? a.fp?.arriving ?? ""} placeholder="----" onSave={(v) => set(a.callsign, "o_ades", v === a.fp?.arriving ? "" : v)} width={52} />
                </td>
                <td>
                  <Cell value={st.rmk ?? ""} placeholder="..." onSave={(v) => set(a.callsign, "rmk", v)} width={110} />
                </td>
                {kind === "arr" && (
                  <td>
                    <button type="button" className="strip-check strip-check--del" aria-pressed={Boolean(st.del)} aria-label="Deleted" onClick={() => set(a.callsign, "del", st.del ? "" : "1")}>
                      {st.del ? "×" : ""}
                    </button>
                  </td>
                )}
                <td>
                  {kind === "dep" ? (
                    (() => {
                      // a tick for the clearance; where the departure is shows on hover
                      const status = departureStatus(a, Boolean(st.c));
                      return (
                        <button
                          type="button"
                          className="strip-check"
                          aria-pressed={Boolean(st.c)}
                          aria-label={`Clearance ${a.callsign}`}
                          title={status.text ? `${status.text}: ${status.title}` : status.title}
                          onClick={() => set(a.callsign, "c", st.c ? "" : "1")}
                        >
                          {st.c ? "✓" : ""}
                        </button>
                      );
                    })()
                  ) : (
                    <button type="button" className="strip-check" aria-pressed={Boolean(st.c)} aria-label="Cleared" onClick={() => set(a.callsign, "c", st.c ? "" : "1")}>
                      {st.c ? "✓" : ""}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!list.length && (
            <tr>
              <td colSpan={10} className="muted">
                No {kind === "dep" ? "departures" : "arrivals"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function StripLists({ code }: { code: string | null }) {
  const apt = useScope((s) => s.apt);
  const aircraft = useScope((s) => s.aircraft);
  if (!apt) return null;
  // departures drop off the list once airborne and climbing through depListMaxFt
  const departing = aircraft.filter((a) => a.dep === apt && (a.onGround || a.altitude < cfg.ui.depListMaxFt));
  const deps = departing.filter((a) => a.arr !== apt).concat(departing.filter((a) => a.arr === apt));
  const arrs = aircraft.filter((a) => a.arr === apt && a.dep !== apt);
  return (
    <>
      <Panel id="strips-dep" title={`Departures ${apt} (${deps.length})`} defaultPos={{ x: 8, y: 60 }} resizable>
        <StripTable list={deps} kind="dep" code={code} />
      </Panel>
      <Panel id="strips-arr" title={`Arrivals ${apt} (${arrs.length})`} defaultPos={{ x: 8, y: 330 }} resizable>
        <StripTable list={arrs} kind="arr" code={code} />
      </Panel>
    </>
  );
}
