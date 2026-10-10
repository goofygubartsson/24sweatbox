// Airborne host controls: CFL, AHDG, ASP, DCT, APPR, HOLD, CCT, LAND / GA, EMER, DEL.
import { useRef, useState } from "react";
import {
  airportRef,
  bearing,
  dist,
  fixes,
  getFix,
  heading3,
  hundreds,
  parseAltitudeInput,
  runwayEndNames,
  unitsToNm,
  type AircraftDTO,
  type Vec,
} from "@sweatbox/shared";
import { api } from "../../lib/api";
import { ListPopup } from "../../components/ListPopup";
import { Popover } from "../../components/Popover";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Controls";
import { useScope } from "../store";
import { runwayChoices } from "../commands";
import type { RAircraft } from "../model";
import { act, range } from "./act";

type Open = null | "cfl" | "ahdg" | "asp" | "dct" | "appr" | "hold" | "cct";

const legNames = { up: "UPWIND", cross: "CROSSWIND", down: "DOWNWIND", base: "BASE", final: "FINAL" } as const;

export function BarField({ k, v, onClick, on, danger, title, disabled, btnRef }: {
  k: string;
  v?: string;
  onClick?: (r: DOMRect) => void;
  on?: boolean;
  danger?: boolean;
  title?: string;
  disabled?: boolean;
  btnRef?: React.RefObject<HTMLButtonElement>;
}) {
  return (
    <button
      ref={btnRef}
      type="button"
      className={`barfield${on ? " barfield--on" : ""}${danger ? " barfield--danger" : ""}`}
      title={title}
      disabled={disabled}
      onClick={(e) => onClick?.(e.currentTarget.getBoundingClientRect())}
    >
      <span className={v === undefined ? undefined : "barfield__k"}>{k}</span>
      {v !== undefined && <span className="barfield__v">{v}</span>}
    </button>
  );
}

export function AirControls({ code, ac }: { code: string; ac: RAircraft & { dto: AircraftDTO } }) {
  const d = ac.dto;
  const [open, setOpen] = useState<Open>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const st = useScope;
  const show = (o: Open) => (r: DOMRect) => {
    setAnchor(r);
    setOpen(open === o ? null : o);
  };
  const close = () => setOpen(null);
  const note = (field: "cfl" | "asp" | "ahdg", v: string | null) => st.getState().setNote(ac.callsign, field, v);

  const sendAlt = async (raw: string | number) => {
    const ft = typeof raw === "number" ? raw : parseAltitudeInput(raw);
    if (ft === null) return st.getState().say(`Not an altitude: ${raw}`, "error-local");
    close();
    if (await act(() => api.air(code, ac.id, { alt: ft }))) note("cfl", hundreds(ft));
  };
  const sendHdg = async (raw: string | number) => {
    const h = Math.round(Number(raw));
    if (!Number.isFinite(h) || h < 1 || h > 360) return st.getState().say(`Heading is 001-360`, "error-local");
    close();
    if (await act(() => api.air(code, ac.id, { hdg: h }))) note("ahdg", heading3(h));
  };
  const sendSpd = async (raw: string | number) => {
    const s = Math.round(Number(raw));
    if (!Number.isFinite(s) || s < 1) return st.getState().say(`Not a speed: ${raw}`, "error-local");
    close();
    if (await act(() => api.air(code, ac.id, { spd: s }))) note("asp", String(s));
  };

  const vsArrow = ac.vs > 300 ? "↑" : ac.vs < -300 ? "↓" : "";
  const apt = st.getState().apt;
  const cct = d.cct;
  const cctLabel = cct ? `${legNames[cct.leg]}${cct.ext ? "+" : ""}` : "";

  return (
    <>
      <span className="bar__item" title="Actual altitude">
        <span className="bar__label">ALT</span>
        <span className="bar__value">
          {hundreds(ac.altitude)}
          {vsArrow}
        </span>
      </span>
      <BarField k="CFL" v={hundreds(d.assigned.alt)} onClick={show("cfl")} title="Cleared level: 80 / FL80 = FL, 8000 = feet" />
      <BarField k="AHDG" v={d.fixList.length || d.approach || d.cct || d.hold ? "---" : heading3(d.assigned.heading)} onClick={show("ahdg")} />
      <BarField k="ASP" v={String(d.assigned.speed)} onClick={show("asp")} />
      <BarField k="DCT" v={d.fixList.length ? d.fixList.slice(0, 2).join(" ") + (d.fixList.length > 2 ? "…" : "") : "---"} onClick={show("dct")} />
      <BarField k="APPR" v={d.approach?.split("-")[1] ?? "---"} on={Boolean(d.approach)} onClick={show("appr")} />
      <BarField k="HOLD" v={d.hold ? d.hold.fix : undefined} on={Boolean(d.hold)} onClick={show("hold")} />
      <BarField k="CCT" v={cctLabel || undefined} on={Boolean(cct)} onClick={show("cct")} />
      <BarField
        k={d.cct?.tng && d.landClr ? "T&G" : "LAND"}
        on={d.landClr}
        disabled={!d.approach && !d.cct}
        title="Toggle the landing clearance"
        onClick={() => void act(() => api.twrAction(code, ac.id, { action: "land" }))}
      />
      <BarField k="GA" disabled={!d.approach && !d.cct} title="Go around" onClick={() => void act(() => api.twrAction(code, ac.id, { action: "ga" }))} />
      <BarField k="EMER" on={d.emergency} danger={d.emergency} onClick={() => void act(() => api.air(code, ac.id, { emer: true }))} />
      <Button variant="danger" confirm="DEL?" onClick={() => void act(() => api.air(code, ac.id, { del: true }))}>
        DEL
      </Button>

      {open === "cfl" && anchor && (
        <ListPopup
          anchor={anchor}
          filter
          placeholder="Level: 80, FL80 or 8000"
          items={range(10, 410, 10)
            .reverse()
            .map((fl) => ({ value: fl * 100, label: String(fl).padStart(3, "0"), text: String(fl) }))}
          initial={Math.round(d.assigned.alt / 1000) * 1000}
          onPick={(v) => void sendAlt(v)}
          onCustom={(t) => void sendAlt(t)}
          onClose={close}
          width={150}
        />
      )}
      {open === "ahdg" && anchor && (
        <ListPopup
          anchor={anchor}
          filter
          placeholder="Heading 001-360"
          items={range(5, 360, 5).map((h) => ({ value: h, label: heading3(h), text: heading3(h) }))}
          initial={Math.round(d.assigned.heading / 5) * 5 || 360}
          onPick={(v) => void sendHdg(v)}
          onCustom={(t) => void sendHdg(t)}
          onClose={close}
          width={130}
        />
      )}
      {open === "asp" && anchor && (
        <ListPopup
          anchor={anchor}
          filter
          placeholder="Speed kt"
          items={range(80, 350, 10)
            .reverse()
            .map((s) => ({ value: s, label: String(s), text: String(s) }))}
          initial={Math.round(d.assigned.speed / 10) * 10}
          onPick={(v) => void sendSpd(v)}
          onCustom={(t) => void sendSpd(t)}
          onClose={close}
          width={130}
        />
      )}
      {open === "appr" && anchor && (
        <ListPopup
          anchor={anchor}
          filter
          placeholder="Runway"
          items={approachChoices(apt, ac).map((r) => ({ value: r.name, label: r.name, hint: r.hint }))}
          onPick={async (rwy) => {
            close();
            if (await act(() => api.air(code, ac.id, { appr: rwy }))) note("ahdg", null);
          }}
          onClose={close}
          width={200}
        />
      )}
      {open === "dct" && anchor && <DctPopover code={code} ac={ac} anchor={anchor} onClose={close} />}
      {open === "hold" && anchor && <HoldPopover code={code} ac={ac} anchor={anchor} onClose={close} />}
      {open === "cct" && anchor && <CctPopover code={code} ac={ac} anchor={anchor} onClose={close} />}
    </>
  );
}

/** Runway ends: the loaded airport (configured arrivals first), then the nearest airports. */
function approachChoices(apt: string | null, ac: RAircraft): { name: string; hint: string }[] {
  const pos: Vec = { x: ac.x, y: ac.y };
  const own = runwayChoices(apt, "arr");
  const rest = runwayEndNames()
    .filter((n) => !own.includes(n))
    .map((n) => ({ n, d: dist(pos, airportRef(n.split("-")[0]!) ?? pos) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.n);
  return [...own, ...rest].map((name) => ({ name, hint: own.includes(name) ? "" : name.split("-")[0]! }));
}

function DctPopover({ code, ac, anchor, onClose }: { code: string; ac: RAircraft & { dto: AircraftDTO }; anchor: DOMRect; onClose: () => void }) {
  const current = ac.dto.fixList;
  const [route, setRoute] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pos = { x: ac.x, y: ac.y };
  const suggestions = q
    ? fixes
        .filter((f) => f.name.startsWith(q.toUpperCase()))
        .sort((a, b) => dist(a.pos, pos) - dist(b.pos, pos))
        .slice(0, 8)
    : [];
  const add = (name: string) => {
    const n = name.toUpperCase().trim();
    if (!n) return;
    if (!getFix(n) && !current.includes(n)) return useScope.getState().say(`Unknown fix ${n}`, "error-local");
    setRoute((r) => [...r, n]);
    setQ("");
    input.current?.focus();
  };
  const send = async (list: string[]) => {
    onClose();
    if (await act(() => api.air(code, ac.id, { dct: list }))) useScope.getState().setNote(ac.callsign, "ahdg", null);
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={340} title={`Direct / route ${ac.callsign}`}>
      <div className="stack">
        {current.length > 0 && (
          <div>
            <div className="label">Current route: direct or skip to</div>
            <div className="chips">
              {current.map((f, i) => (
                <span key={`${f}${i}`} className="row" style={{ gap: 2 }}>
                  <Chip onClick={() => void send([f])} title={`Direct ${f}, then hold heading`}>
                    DCT {f}
                  </Chip>
                  {i > 0 && (
                    <Chip onClick={() => void send(current.slice(i))} title={`Skip to ${f} and continue the route`}>
                      ⇢
                    </Chip>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="label">New route (click a chip to remove)</div>
          <div className="chips">
            {route.map((f, i) => (
              <Chip key={`${f}${i}`} onRemove={() => setRoute((r) => r.filter((_, k) => k !== i))}>
                {f}
              </Chip>
            ))}
            {!route.length && <span className="muted">type fixes below</span>}
          </div>
        </div>
        <input
          ref={input}
          className="field"
          placeholder="Fix name, Enter to add"
          value={q}
          onChange={(e) => setQ(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!q && route.length) void send(route);
              else add(suggestions.find((s) => s.name === q)?.name ?? suggestions[0]?.name ?? q);
            }
            if (e.key === "Backspace" && !q) setRoute((r) => r.slice(0, -1));
          }}
        />
        {suggestions.length > 0 && (
          <div className="chips">
            {suggestions.map((s) => (
              <Chip key={s.name} onClick={() => add(s.name)} title={`${Math.round(bearing(pos, s.pos))}° ${unitsToNm(dist(pos, s.pos)).toFixed(1)} NM`}>
                {s.name}
              </Chip>
            ))}
          </div>
        )}
        <div className="row">
          <Button variant="primary" disabled={!route.length} onClick={() => void send(route)}>
            Send direct
          </Button>
          <Button variant="ghost" onClick={() => void send([])} disabled={!current.length}>
            Cancel route
          </Button>
        </div>
      </div>
    </Popover>
  );
}

function HoldPopover({ code, ac, anchor, onClose }: { code: string; ac: RAircraft & { dto: AircraftDTO }; anchor: DOMRect; onClose: () => void }) {
  const d = ac.dto;
  const [fix, setFix] = useState(d.fixList[0] ?? "PPOS");
  const [course, setCourse] = useState("");
  const [turn, setTurn] = useState<"L" | "R">("R");
  const [leg, setLeg] = useState("60");
  const [alt, setAlt] = useState("");
  const [spd, setSpd] = useState("");
  const send = async () => {
    const body: Parameters<typeof api.twrAction>[2] & { action: "hold" } = { action: "hold", turn, leg: Math.min(600, Math.max(20, Number(leg) || 60)) };
    if (fix && fix !== "PPOS") body.fix = fix.toUpperCase();
    if (course) body.course = Math.round(Number(course));
    const a = alt ? parseAltitudeInput(alt) : null;
    if (a !== null) body.alt = a;
    if (spd) body.spd = Math.min(450, Math.max(60, Math.round(Number(spd))));
    onClose();
    if (await act(() => api.twrAction(code, ac.id, body))) {
      if (a !== null) useScope.getState().setNote(ac.callsign, "cfl", hundreds(a));
      useScope.getState().setNote(ac.callsign, "ahdg", null);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={280} title={`Hold ${ac.callsign}`}>
      <div className="form-grid">
        <label htmlFor="hold-fix">Fix</label>
        <input id="hold-fix" className="field" value={fix} onChange={(e) => setFix(e.target.value.toUpperCase())} placeholder="PPOS" />
        <label htmlFor="hold-crs">Inbound</label>
        <input id="hold-crs" className="field" value={course} onChange={(e) => setCourse(e.target.value)} placeholder="track to the fix" />
        <label>Turns</label>
        <span className="seg">
          {(["L", "R"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={turn === t} onClick={() => setTurn(t)}>
              {t === "L" ? "LEFT" : "RIGHT"}
            </button>
          ))}
        </span>
        <label htmlFor="hold-leg">Leg (s)</label>
        <input id="hold-leg" className="field" value={leg} onChange={(e) => setLeg(e.target.value)} />
        <label htmlFor="hold-alt">Alt</label>
        <input id="hold-alt" className="field" value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="optional" />
        <label htmlFor="hold-spd">Speed</label>
        <input id="hold-spd" className="field" value={spd} onChange={(e) => setSpd(e.target.value)} placeholder="optional, 60-450" />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button variant="primary" onClick={() => void send()}>
          Hold
        </Button>
        {d.hold && (
          <Button
            variant="secondary"
            onClick={async () => {
              onClose();
              await act(() => api.twrAction(code, ac.id, { action: "xhold" }));
            }}
          >
            Leave hold
          </Button>
        )}
      </div>
    </Popover>
  );
}

export function CctPopover({ code, ac, anchor, onClose }: { code: string; ac: RAircraft & { dto: AircraftDTO }; anchor: DOMRect; onClose: () => void }) {
  const d = ac.dto;
  const apt = useScope.getState().apt ?? ac.dep ?? ac.arr;
  const choices = runwayChoices(apt, "arr");
  const [rwy, setRwy] = useState(choices[0] ?? "");
  const [side, setSide] = useState<"AUTO" | "L" | "R">("AUTO");
  const [tng, setTng] = useState(true);
  const [join, setJoin] = useState<"DW" | "BASE" | "UP" | "CROSS" | "DOWN">(ac.onGround ? "UP" : "DW");
  const twr = (body: Parameters<typeof api.twrAction>[2]) => {
    onClose();
    return act(() => api.twrAction(code, ac.id, body));
  };
  if (d.cct && !ac.onGround) {
    const extendable = d.cct.leg === "up" || d.cct.leg === "cross" || d.cct.leg === "down";
    return (
      <Popover anchor={anchor} onClose={onClose} width={260} title={`Circuit ${d.cct.rwy} ${d.cct.side === "L" ? "left" : "right"}`}>
        <p className="muted" style={{ margin: "0 0 8px" }}>
          Leg {legNames[d.cct.leg]}
          {d.cct.ext ? " (extended)" : ""} · {d.cct.tng ? "touch and go" : "full stop"}
        </p>
        <div className="stack">
          <Button disabled={!extendable} onClick={() => void twr({ action: "ext" })}>
            {d.cct.ext ? "Turn now" : "Extend leg"}
          </Button>
          <Button variant="secondary" onClick={() => void twr({ action: "tng" })}>
            {d.cct.tng ? "Make it a full stop" : "Make it touch and go"}
          </Button>
          <Button variant="danger" onClick={() => void twr({ action: "xcct" })}>
            Leave the circuit
          </Button>
        </div>
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={300} title={ac.onGround ? `Circuit after departure ${ac.callsign}` : `Join the circuit ${ac.callsign}`}>
      <div className="form-grid">
        <label htmlFor="cct-rwy">Runway</label>
        <select id="cct-rwy" className="field" value={rwy} onChange={(e) => setRwy(e.target.value)}>
          {(choices.length ? choices : runwayEndNames()).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <label>Side</label>
        <span className="seg">
          {(["AUTO", "L", "R"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}>
              {s === "AUTO" ? "AUTO" : s === "L" ? "LEFT" : "RIGHT"}
            </button>
          ))}
        </span>
        <label>Type</label>
        <span className="seg">
          <button type="button" aria-pressed={tng} onClick={() => setTng(true)}>
            TOUCH &amp; GO
          </button>
          <button type="button" aria-pressed={!tng} onClick={() => setTng(false)}>
            FULL STOP
          </button>
        </span>
        {!ac.onGround && (
          <>
            <label>Join</label>
            <span className="seg">
              {(["DW", "BASE", "UP", "CROSS", "DOWN"] as const).map((j) => (
                <button key={j} type="button" aria-pressed={join === j} onClick={() => setJoin(j)} title={j === "DOWN" ? "Downwind direct" : undefined}>
                  {j}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button
          variant="primary"
          disabled={!rwy}
          onClick={() => void twr({ action: "cct", runway: rwy, ...(side !== "AUTO" ? { side } : {}), tng, join })}
        >
          Start circuit
        </Button>
        {d.cct && (
          <Button variant="ghost" onClick={() => void twr({ action: "xcct" })}>
            Cancel circuit
          </Button>
        )}
      </div>
    </Popover>
  );
}

