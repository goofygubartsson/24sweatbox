// Sweatbox Maker (/maker, trainers only): generate traffic for an airport, position and runway
// format, adjust individual aircraft, then download it or load it into a session.
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import cfg from "@sweatbox/config/public";
import {
  GeneratorError,
  KINDS,
  POSITIONS,
  TRAFFIC_LEVELS,
  add,
  airportRef,
  appr,
  expandRoute,
  findRunwayEnd,
  formatClock,
  generatorAirports,
  getGroundGraph,
  hasGroundMap,
  knownTypes,
  makeItem,
  needsGroundMap,
  runwayFormats,
  rwyEnd,
  scale,
  type Kind,
  type Position,
  type SweatboxItem,
} from "@sweatbox/shared";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useSearch } from "../../lib/router";
import { Header } from "../../components/Header";
import { Button } from "../../components/Button";
import { toast } from "../../components/Toast";
import { ScopeView, type ScopeHandle } from "../../scope/ScopeView";
import type { MakerOverlay, Scene } from "../../scope/draw";
import { clearDraft, draftFormat, draftName, draftScript, generateItems, loadDraft, saveDraft, validate, type MakerDraft } from "./model";

const U = cfg.sim.unitsPerNm;
const KIND_COLOUR: Record<Kind, string> = {
  "dep-stand": cfg.colours.departure,
  "dep-air": cfg.colours.departure,
  "arr-final": cfg.colours.arrival,
  inbound: cfg.colours.arrival,
  "cct-ga": cfg.colours.local,
};

// ---- access and crash handling -----------------------------------------------------------------

class MakerBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <Header />
        <main className="page__main stack" role="alert">
          <p className="error-text" style={{ margin: 0 }}>
            The Maker hit a problem: {this.state.error.message}
          </p>
          <div>
            <Button
              onClick={() => {
                clearDraft();
                this.setState({ error: null });
              }}
            >
              Reset the Maker
            </Button>
          </div>
        </main>
      </div>
    );
  }
}

export function MakerPage() {
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  if (!loaded) return <div className="page" />;
  if (!me?.isHost)
    return (
      <div className="page">
        <Header />
        <main className="page__main">
          <p style={{ margin: 0 }}>
            {me ? "The Maker is only available to trainers." : "Log in to use the Maker."} <a href="/">Back to the start</a>
          </p>
        </main>
      </div>
    );
  return (
    <MakerBoundary>
      <Maker />
    </MakerBoundary>
  );
}

// ---- the maker -------------------------------------------------------------------------------------

function Maker() {
  const [draft, setDraft] = useState<MakerDraft>(loadDraft);
  const [selected, setSelected] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [sessionCode, setSessionCode] = useState(useSearch().get("session") ?? "");
  const scope = useRef<ScopeHandle | null>(null);
  const [mapVersion, setMapVersion] = useState(0);
  const [initialView] = useState(() => {
    const ref = airportRef(draft.apt);
    return ref ? { cx: ref.x, cy: ref.y, zoom: cfg.ui.defaultZoom } : undefined;
  });

  useEffect(() => {
    const t = window.setTimeout(() => saveDraft(draft), 400);
    return () => window.clearTimeout(t);
  }, [draft]);

  const gen = useMemo(() => draftScript(draft), [draft]);
  const issues = useMemo(() => (gen ? validate(draft, gen) : []), [draft, gen]);
  const errors = issues.filter((i) => i.level === "error");
  const sel = draft.items.find((i) => i.id === selected) ?? null;
  const format = draftFormat(draft);
  const ground = hasGroundMap(draft.apt);

  useEffect(() => {
    const ref = airportRef(draft.apt);
    if (ref && scope.current) {
      scope.current.camera.set(ref.x, ref.y, cfg.ui.defaultZoom);
      scope.current.invalidate();
    }
  }, [draft.apt]);
  useEffect(() => setMapVersion((v) => v + 1), [draft, selected]);

  const setSettings = (patch: Partial<MakerDraft>) => {
    setGenError(null);
    setDraft((d) => {
      const n = { ...d, ...patch };
      if (patch.apt) {
        const f = runwayFormats(n.apt);
        if (!f.some((x) => x.id === n.runway)) n.runway = f[0]?.id ?? "";
        if (needsGroundMap(n.position) && !hasGroundMap(n.apt)) n.position = "TWR";
      }
      return n;
    });
  };

  const generate = () => {
    try {
      setDraft((d) => ({ ...d, items: generateItems(d) }));
      setSelected(null);
      setGenError(null);
    } catch (e) {
      setGenError(e instanceof GeneratorError ? e.message : (e as Error).message);
    }
  };

  const addItem = (kind: Kind) => {
    if (!format) return;
    const time = draft.items.length ? Math.max(...draft.items.map((i) => i.time)) + 60 : 0;
    const it = makeItem({ apt: draft.apt, position: draft.position, format, items: draft.items }, kind, time);
    if (!it) return toast(ground ? "No free stand at that time" : `${draft.apt} has no ground map, so nothing can be parked`, "error");
    setDraft((d) => ({ ...d, items: [...d.items, it] }));
    setSelected(it.id);
  };
  const updateItem = (id: string, patch: Partial<SweatboxItem>) => setDraft((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const removeItem = (id: string) => setDraft((d) => ({ ...d, items: d.items.filter((i) => i.id !== id) }));

  const download = () => {
    if (!gen) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([gen.text], { type: "text/plain" }));
    a.download = `${draftName(draft)}.sbx`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const loadIntoSession = async () => {
    if (!gen) return;
    if (errors.length) return toast("Fix the errors first", "error");
    const code = sessionCode.trim();
    if (code.length !== cfg.session.codeLength) return toast(`Enter the ${cfg.session.codeLength}-letter session code`, "error");
    try {
      const r = await api.loadScript(code, { text: gen.text, label: draftName(draft) });
      toast(`Loaded into ${code} (${r.commandCount} commands)`, "ok");
    } catch (e) {
      const err = e as ApiError;
      toast(err.status === 404 ? `No session ${code}` : (err.errors?.[0] ?? err.message), "error", 6000);
    }
  };

  const overlay = useMemo((): MakerOverlay => {
    const points: MakerOverlay["points"] = [];
    const lines: MakerOverlay["lines"] = [];
    const stands: MakerOverlay["stands"] = [];
    const g = getGroundGraph(draft.apt);
    const warnStands = new Set(issues.filter((i) => i.text.startsWith("Stand ")).map((i) => /Stand \S+-(\S+)/.exec(i.text)?.[1]));
    for (const it of draft.items) {
      const colour = KIND_COLOUR[it.kind];
      const isSel = it.id === selected;
      if (it.kind === "dep-stand" || it.kind === "cct-ga") {
        const s = g?.standByName.get(it.stand.toUpperCase());
        if (g && s) stands.push({ x: g.nodes[s.n]!.x, y: g.nodes[s.n]!.y, label: `${it.cs} ${s.name}`, warn: warnStands.has(s.name) });
      } else if (it.kind === "dep-air") {
        continue; // drawn once per runway below: they all start from the same point
      } else if (it.kind === "arr-final") {
        const end = findRunwayEnd(`${draft.apt}-${it.runway}`);
        if (end) {
          const a = appr(end);
          const p = add(a.threshold, scale(a.out, it.distNm * U));
          points.push({ x: p.x, y: p.y, label: it.cs, colour, selected: isSel });
          lines.push({ pts: [[p.x, p.y], [a.threshold.x, a.threshold.y]], colour, dashed: true });
        }
      } else {
        points.push({ x: it.x, y: it.y, label: it.cs, colour, selected: isSel });
        const ex = expandRoute(it.route, { dep: it.dep, arr: it.arr });
        if (ex.heading !== null) {
          const rad = (ex.heading * Math.PI) / 180;
          lines.push({ pts: [[it.x, it.y], [it.x + Math.sin(rad) * 10 * U, it.y - Math.cos(rad) * 10 * U]], colour, dashed: true });
        }
      }
    }
    // airborne departures: one marker per runway, with a count (or the selected callsign)
    const deps = new Map<string, SweatboxItem[]>();
    for (const it of draft.items) if (it.kind === "dep-air") deps.set(it.runway, [...(deps.get(it.runway) ?? []), it]);
    for (const [rwy, list] of deps) {
      const end = findRunwayEnd(`${draft.apt}-${rwy}`);
      if (!end) continue;
      const r = rwyEnd(end);
      const p = add(r.start, scale(r.dir, r.length * cfg.sim.depSpawnRunwayFraction));
      const picked = list.find((i) => i.id === selected);
      points.push({ x: p.x, y: p.y, label: picked ? picked.cs : `${list.length} departing ${rwy}`, colour: KIND_COLOUR["dep-air"], selected: Boolean(picked) });
    }
    return { points, lines, stands };
  }, [draft, issues, selected]);

  const scene = useCallback(
    (): Scene => ({
      aircraft: [],
      apt: draft.apt,
      mode: "CTR",
      fixesAlways: true,
      selectedId: null,
      notes: {},
      assumed: new Set(),
      strips: {},
      routes: new Set(),
      routeFor: () => [],
      centrelines: format ? format.arr.map((d) => `${draft.apt}-${d}`) : [],
      taxiPath: null,
      pickNodes: false,
      pickedNodes: [],
      hoverNode: null,
      maker: overlay,
      tags: false,
    }),
    [draft.apt, format, overlay],
  );

  return (
    <div className="page maker-page">
      <Header />
      <div className="maker__toolbar">
        <strong>{draftName(draft)}</strong>
        <span className={errors.length ? "error-text" : "muted"} style={{ fontSize: 12 }}>
          {draft.items.length} aircraft · {errors.length ? `${errors.length} error(s)` : "ready"}
        </span>
        <span className="grow" />
        <Button onClick={download} disabled={!gen || !draft.items.length}>
          Download .sbx
        </Button>
        <input
          className="field"
          style={{ width: 120 }}
          placeholder="Session code"
          aria-label="Session code"
          maxLength={cfg.session.codeLength}
          value={sessionCode}
          onChange={(e) => setSessionCode(e.target.value.replace(/[^A-Za-z]/g, ""))}
        />
        <Button variant="primary" onClick={() => void loadIntoSession()} disabled={!draft.items.length}>
          Load into session
        </Button>
      </div>
      <div className="maker">
        <aside className="maker__col">
          <section className="maker__section">
            <h2>Sweatbox</h2>
            <div className="form-grid">
              <label htmlFor="mk-apt">Airport</label>
              <select id="mk-apt" className="field" value={draft.apt} onChange={(e) => setSettings({ apt: e.target.value })}>
                {generatorAirports().map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
              <label htmlFor="mk-pos">Position</label>
              <select id="mk-pos" className="field" value={draft.position} onChange={(e) => setSettings({ position: e.target.value as Position })}>
                {POSITIONS.map((p) => (
                  <option key={p} value={p} disabled={needsGroundMap(p) && !ground}>
                    {p}
                    {needsGroundMap(p) && !ground ? " (needs a ground map)" : ""}
                  </option>
                ))}
              </select>
              <label htmlFor="mk-rwy">Runway format</label>
              <select id="mk-rwy" className="field" value={draft.runway} onChange={(e) => setSettings({ runway: e.target.value })}>
                {runwayFormats(draft.apt).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <label htmlFor="mk-level">Traffic</label>
              <select id="mk-level" className="field" value={draft.level} onChange={(e) => setSettings({ level: e.target.value as MakerDraft["level"] })}>
                {TRAFFIC_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l[0]!.toUpperCase() + l.slice(1)}
                  </option>
                ))}
              </select>
              <label htmlFor="mk-dur">Minutes</label>
              <input
                id="mk-dur"
                type="number"
                className="field"
                min={5}
                max={240}
                value={draft.durationMin}
                onChange={(e) => setSettings({ durationMin: Math.max(5, Math.min(240, Math.round(Number(e.target.value)) || cfg.generator.durationMin)) })}
              />
            </div>
            {genError && (
              <p className="error-text" role="alert" style={{ margin: 0 }}>
                {genError}
              </p>
            )}
            <Button variant="primary" confirm={draft.items.length ? "Replace the traffic?" : undefined} onClick={generate}>
              Generate traffic
            </Button>
          </section>
          <section className="maker__section">
            <h2>Add aircraft</h2>
            <div className="stack">
              {(Object.keys(KINDS) as Kind[]).map((k) => (
                <Button key={k} onClick={() => addItem(k)} disabled={(k === "dep-stand" || k === "cct-ga") && !ground}>
                  {KINDS[k]}
                </Button>
              ))}
            </div>
          </section>
          <section className="maker__section">
            <h2>Checks</h2>
            {!issues.length && <span className="muted">No problems found.</span>}
            <ul className="issues">
              {issues.map((i, k) => (
                <li key={k}>
                  <button type="button" className={`issue issue--${i.level}`} onClick={() => i.itemId && setSelected(i.itemId)}>
                    {i.text}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="maker__center">
          <div className="maker__map">
            <ScopeView
              scene={scene}
              version={mapVersion}
              handleRef={scope}
              rulers={false}
              initialView={initialView}
              onMapClick={(p) => {
                if (sel?.kind === "inbound") updateItem(sel.id, { x: Math.round(p.x * 1e5) / 1e5, y: Math.round(p.y * 1e5) / 1e5 });
              }}
            />
            {sel?.kind === "inbound" && <div className="maker__maphint">Click the map to place {sel.cs}</div>}
          </div>
          <div className="maker__table">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Callsign</th>
                  <th>Type</th>
                  <th>Aircraft</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...draft.items]
                  .sort((a, b) => a.time - b.time)
                  .map((it) => (
                    <tr key={it.id} aria-selected={it.id === selected} onClick={() => setSelected(it.id)} style={{ cursor: "pointer" }}>
                      <td className="data">{formatClock(it.time)}</td>
                      <td className="data">{it.cs}</td>
                      <td className="data">{it.type}</td>
                      <td>{summary(draft, it)}</td>
                      <td style={{ width: 28 }}>
                        <button
                          type="button"
                          className="iconbtn"
                          aria-label={`Remove ${it.cs}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeItem(it.id);
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                {!draft.items.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No traffic yet. Generate traffic or add aircraft one at a time.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>

        <aside className="maker__col">{sel ? <Editor key={sel.id} draft={draft} item={sel} onChange={(p) => updateItem(sel.id, p)} /> : <section className="maker__section muted">Select an aircraft to edit it.</section>}</aside>
      </div>
    </div>
  );
}

function summary(d: MakerDraft, it: SweatboxItem): string {
  switch (it.kind) {
    case "dep-stand":
      return `Stand ${it.stand} → ${it.runway} → ${it.arr}`;
    case "dep-air":
      return `Departs ${it.runway} → ${it.arr}`;
    case "arr-final":
      return `${it.dep} → ${it.distNm} NM final ${it.runway}`;
    case "inbound":
      return `${it.dep} → ${d.apt} at ${it.alt} ft`;
    case "cct-ga":
      return `Stand ${it.stand}, circuits ${it.runway} ${it.side === "L" ? "left" : "right"}`;
  }
}

// ---- editor --------------------------------------------------------------------------------------

function Editor({ draft, item, onChange }: { draft: MakerDraft; item: SweatboxItem; onChange: (p: Partial<SweatboxItem>) => void }) {
  const g = getGroundGraph(draft.apt);
  const rwys = runwayFormats(draft.apt).flatMap((f) => f.label.split(" / "));
  const text = (k: keyof SweatboxItem, label: string) => (
    <>
      <label htmlFor={`ed-${k}`}>{label}</label>
      <input id={`ed-${k}`} className="field" value={String(item[k] ?? "")} onChange={(e) => onChange({ [k]: e.target.value.toUpperCase() } as Partial<SweatboxItem>)} />
    </>
  );
  const num = (k: keyof SweatboxItem, label: string, step = 1) => (
    <>
      <label htmlFor={`ed-${k}`}>{label}</label>
      <input id={`ed-${k}`} type="number" step={step} className="field" value={Number(item[k] ?? 0)} onChange={(e) => onChange({ [k]: Number(e.target.value) } as Partial<SweatboxItem>)} />
    </>
  );
  const runway = (
    <>
      <label htmlFor="ed-rwy">Runway</label>
      <select id="ed-rwy" className="field" value={item.runway} onChange={(e) => onChange({ runway: e.target.value })}>
        {rwys.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
    </>
  );
  const stand = (
    <>
      <label htmlFor="ed-stand">Stand</label>
      <select id="ed-stand" className="field" value={item.stand} onChange={(e) => onChange({ stand: e.target.value })}>
        {(g?.stands ?? []).map((s) => (
          <option key={s.name}>{s.name}</option>
        ))}
      </select>
    </>
  );
  return (
    <section className="maker__section">
      <h2>{KINDS[item.kind]}</h2>
      <div className="form-grid">
        <label htmlFor="ed-time">Time (s)</label>
        <input id="ed-time" type="number" min={0} className="field" value={item.time} onChange={(e) => onChange({ time: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        {text("cs", "Callsign")}
        <label htmlFor="ed-type">Type</label>
        <input id="ed-type" className="field" list="maker-types" value={item.type} onChange={(e) => onChange({ type: e.target.value.toUpperCase() })} />
        {item.kind === "dep-stand" && (
          <>
            {stand}
            {runway}
            {num("climb", "Climb (ft)", 500)}
            {text("arr", "Destination")}
          </>
        )}
        {item.kind === "dep-air" && (
          <>
            {runway}
            {num("climb", "Climb (ft)", 500)}
            {text("arr", "Destination")}
          </>
        )}
        {item.kind === "arr-final" && (
          <>
            {runway}
            {num("distNm", "Final (NM)")}
            {text("dep", "From")}
          </>
        )}
        {item.kind === "inbound" && (
          <>
            {num("alt", "Altitude (ft)", 500)}
            {num("gs", "Speed (kt)", 10)}
            {text("route", "Route")}
            {text("dep", "From")}
          </>
        )}
        {item.kind === "cct-ga" && (
          <>
            {stand}
            {runway}
            <label>Side</label>
            <span className="seg">
              {(["L", "R"] as const).map((s) => (
                <button key={s} type="button" aria-pressed={item.side === s} onClick={() => onChange({ side: s })}>
                  {s === "L" ? "Left" : "Right"}
                </button>
              ))}
            </span>
          </>
        )}
      </div>
      <datalist id="maker-types">
        {knownTypes().map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </section>
  );
}
