// Ground host controls (spec 8.3): status, PUSH, TAXI, STOP/CONT, FLW, CLB + TKOF, CCT, EMER, DEL.
import { useEffect, useMemo, useRef, useState } from "react";
import { entryNearHold, getGroundGraph, heading3, hundreds, parseAltitudeInput, type AircraftDTO } from "@sweatbox/shared";
import { api } from "../../lib/api";
import { ListPopup } from "../../components/ListPopup";
import { Popover } from "../../components/Popover";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Controls";
import { useScope } from "../store";
import { runwayChoices } from "../commands";
import type { RAircraft } from "../model";
import { act, range } from "./act";
import { BarField, CctPopover } from "./AirControls";

type Open = null | "push" | "taxi" | "flw" | "clb" | "tkof" | "cct";

export function GroundControls({ code, ac }: { code: string; ac: RAircraft & { dto: AircraftDTO } }) {
  const g = ac.dto.gnd!;
  const graph = getGroundGraph(g.apt);
  const [open, setOpen] = useState<Open>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const taxiBtn = useRef<HTMLButtonElement>(null);
  const strip = useScope((s) => s.strips[ac.callsign]);
  const clb = Number(strip?.o_clmb ?? strip?.clmb ?? g.climb) || g.climb;
  const pick = useScope((s) => s.pick);
  // taxi draft survives closing the popover (map picking)
  const [route, setRoute] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  useEffect(() => {
    setRoute([]);
    setTarget("");
  }, [ac.id]);

  const show = (o: Open) => (r: DOMRect) => {
    setAnchor(r);
    setOpen(open === o ? null : o);
  };
  const close = () => setOpen(null);
  const gnd = (body: Parameters<typeof api.gnd>[2]) => act(() => api.gnd(code, ac.id, body));

  const taxiways = useMemo(() => (graph ? [...graph.taxiways].filter((t) => !t.includes("/")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : []), [graph]);
  const targets = useMemo(() => {
    if (!graph) return [];
    return [
      { value: "", label: "End of route", section: "Target" },
      // hold names carry the runway ("B1 07L/25R"); a hold with no runway entry beside it only guards a crossing
      ...graph.holds.map((h) => ({ value: `H:${h.name}`, label: `HOLD ${h.name}`, hint: entryNearHold(graph, h) ? undefined : "crossing", section: "Runway holds" })),
      ...graph.stands.map((s) => ({ value: `S:${s.name}`, label: `STAND ${s.name}`, section: "Stands" })),
      ...taxiways.filter((t) => t !== "APRON").map((t) => ({ value: `T:${t}`, label: `SHORT OF ${t}`, section: "Hold short of" })),
    ];
  }, [graph, taxiways]);

  const sendTaxi = async () => {
    const nodes = pick?.kind === "taxi" ? pick.nodes : [];
    close();
    useScope.getState().set({ pick: null });
    if (await gnd({ action: "taxi", route, nodes, target })) {
      setRoute([]);
      setTarget("");
    }
  };

  const moving = ["push", "taxi", "follow", "lineup", "rollout"].includes(g.mode);
  const leaders = useScope.getState().aircraft.filter((o) => o.id !== ac.id && o.onGround && o.dto?.gnd?.apt === g.apt);

  return (
    <>
      <span className="bar__item gndstatus" title={g.status}>
        {g.status}
        {g.spacing && <span className="muted"> · spacing</span>}
      </span>
      <BarField k="PUSH" disabled={g.mode !== "stand"} onClick={show("push")} />
      <BarField k="TAXI" btnRef={taxiBtn} disabled={g.mode === "stand"} on={pick?.kind === "taxi"} onClick={show("taxi")} />
      {g.paused ? (
        <BarField k="CONT" on onClick={() => void gnd({ action: "cont" })} />
      ) : (
        <BarField k="STOP" disabled={!moving} onClick={() => void gnd({ action: "stop" })} />
      )}
      <BarField k="FLW" disabled={g.mode === "stand"} onClick={show("flw")} />
      <BarField k="CLB" v={hundreds(clb)} onClick={show("clb")} title="Initial climb for the departure (shared strip CLMB)" />
      {g.mode === "lined" ? (
        <BarField k="TKOF" v={g.rwy?.split("-")[1]} on onClick={() => void gnd({ action: "tkof", runway: g.rwy!, altitude: clb })} title="Cleared for takeoff" />
      ) : (
        <BarField k="TKOF" disabled={g.mode === "stand"} onClick={show("tkof")} />
      )}
      <BarField k="CCT" v={ac.dto.cct ? ac.dto.cct.rwy.split("-")[1] : undefined} on={Boolean(ac.dto.cct)} onClick={show("cct")} />
      <BarField k="EMER" on={ac.dto.emergency} danger={ac.dto.emergency} onClick={() => void act(() => api.air(code, ac.id, { emer: true }))} />
      <Button variant="danger" confirm="DEL?" onClick={() => void act(() => api.air(code, ac.id, { del: true }))}>
        DEL
      </Button>

      {open === "push" && anchor && (
        <Popover anchor={anchor} onClose={close} width={240} title={`Pushback ${ac.callsign}`}>
          <div className="stack">
            {g.pushFacing.map((o) => (
              <Button
                key={`${o.hdg}${o.twy}`}
               
                onClick={() => {
                  close();
                  void gnd({ action: "push", facing: o.hdg });
                }}
              >
                Face {heading3(o.hdg)} on {o.twy}
              </Button>
            ))}
            <Button
              variant="secondary"
              onClick={() => {
                close();
                useScope.getState().set({ pick: { kind: "push", nodes: [] } });
              }}
            >
              Pick a push-to point on the map
            </Button>
          </div>
        </Popover>
      )}

      {open === "taxi" && anchor && (
        <Popover anchor={anchor} onClose={close} width={380} title={`Taxi ${ac.callsign}`}>
          <div className="stack">
            <div className="label">Route (click taxiways in order, or type "A K" + Enter)</div>
            <div className="chips">
              {route.map((t, i) => (
                <Chip key={`${t}${i}`} onRemove={() => setRoute((r) => r.filter((_, k) => k !== i))}>
                  {t}
                </Chip>
              ))}
              {!route.length && <span className="muted">shortest path</span>}
            </div>
            <input
              className="field"
              placeholder="Taxiways, e.g. A K"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = (e.target as HTMLInputElement).value.trim().toUpperCase();
                if (v) {
                  setRoute((r) => [...r, ...v.split(/[\s,]+/)]);
                  (e.target as HTMLInputElement).value = "";
                } else void sendTaxi();
              }}
            />
            <div className="chips" style={{ maxHeight: 84, overflow: "auto" }}>
              {taxiways.map((t) => (
                <Chip key={t} onClick={() => setRoute((r) => [...r, t])}>
                  {t}
                </Chip>
              ))}
            </div>
            <div className="row">
              <span className="label" style={{ margin: 0 }}>
                Target
              </span>
              <select className="field grow" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Taxi target">
                {targets.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                    {"hint" in t && t.hint ? ` (${t.hint})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <Button
                variant="secondary"
                active={pick?.kind === "taxi"}
                onClick={() => {
                  close();
                  useScope.getState().set({ pick: { kind: "taxi", nodes: pick?.kind === "taxi" ? pick.nodes : [] } });
                }}
              >
                Pick points on map{pick?.kind === "taxi" && pick.nodes.length ? ` (${pick.nodes.length})` : ""}
              </Button>
              <span className="grow" />
              <Button variant="primary" onClick={() => void sendTaxi()}>
                Taxi
              </Button>
            </div>
          </div>
        </Popover>
      )}

      {open === "flw" && anchor && (
        <ListPopup
          anchor={anchor}
          filter
          placeholder="Follow which aircraft?"
          items={leaders.map((l) => ({ value: l.id, label: l.callsign, hint: l.dto?.gnd?.status.slice(0, 24) }))}
          onPick={(id) => {
            close();
            void gnd({ action: "follow", leader: id });
          }}
          onClose={close}
          width={260}
        />
      )}

      {open === "clb" && anchor && (
        <ListPopup
          anchor={anchor}
          filter
          placeholder="Climb: 3000, 50 or FL050"
          items={range(1000, 10000, 1000).map((a) => ({ value: a, label: String(a) }))}
          initial={clb}
          onPick={(v) => {
            close();
            void act(() => api.strip(code, ac.callsign, "clmb", String(v)));
          }}
          onCustom={(t) => {
            const v = parseAltitudeInput(t);
            close();
            if (v !== null) void act(() => api.strip(code, ac.callsign, "clmb", String(v)));
          }}
          onClose={close}
          width={170}
        />
      )}

      {open === "tkof" && anchor && <TkofPopover anchor={anchor} onClose={close} runways={runwayChoices(g.apt, "dep")} onSend={(rwy, wait) => void gnd({ action: "tkof", runway: rwy, altitude: clb, wait })} />}
      {open === "cct" && anchor && <CctPopover code={code} ac={ac} anchor={anchor} onClose={close} />}

      {pick && (
        <div className="pickbanner" role="status">
          {pick.kind === "taxi" && `Click intersections to taxi through (${pick.nodes.length} picked)`}
          {pick.kind === "push" && "Click the point to push back to"}
          {pick.kind === "follow" && "Click the point to follow until"}
          {pick.kind === "taxi" && (
            <Button
              variant="primary"
              onClick={() => {
                const r = taxiBtn.current?.getBoundingClientRect();
                if (r) setAnchor(r);
                setOpen("taxi");
              }}
            >
              Done
            </Button>
          )}
          <Button variant="ghost" onClick={() => useScope.getState().set({ pick: null })}>
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}

function TkofPopover({ anchor, onClose, runways, onSend }: { anchor: DOMRect; onClose: () => void; runways: string[]; onSend: (rwy: string, wait: boolean) => void }) {
  const [wait, setWait] = useState(false);
  return (
    <Popover anchor={anchor} onClose={onClose} width={240} title="Takeoff">
      <label className="row" style={{ marginBottom: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={wait} onChange={(e) => setWait(e.target.checked)} /> Line up and wait
      </label>
      <div className="stack">
        {runways.map((r) => (
          <Button
            key={r}
           
            onClick={() => {
              onClose();
              onSend(r, wait);
            }}
          >
            {wait ? "Line up" : "Takeoff"} {r.split("-")[1]}
          </Button>
        ))}
        {!runways.length && <span className="muted">No runways at this airport</span>}
      </div>
    </Popover>
  );
}
