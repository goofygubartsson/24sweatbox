// Replay player: open / drop a replay file, or receive one from a just-ended session tab.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cfg from "@sweatbox/config/public";
import { SESSION_CODE_RE, formatClock, getGroundGraph, airports, dist, airportRef, ReplayFileSchema, type ReplayFile } from "@sweatbox/shared";
import { Header } from "../components/Header";
import { Button } from "../components/Button";
import { toast } from "../components/Toast";
import { ScopeView, type ScopeHandle } from "../scope/ScopeView";
import type { Scene } from "../scope/draw";
import { fromReplay, type RAircraft } from "../scope/model";
import { useScope } from "../scope/store";
import { switchView, stationLabel } from "../scope/views";
import { REPLAY_DATA, REPLAY_READY } from "../scope/EndScreen";
import { api, ApiError } from "../lib/api";
import { useSearch } from "../lib/router";

const SPEEDS = [1, 2, 4, 8, 16];
const TRAIL_EVERY = 3; // frames between history dots

function parseReplay(raw: unknown): ReplayFile {
  const r = ReplayFileSchema.safeParse(raw);
  if (!r.success) throw new Error("This is not an ATC24Academy Sweatbox replay file");
  return r.data as unknown as ReplayFile;
}

export function ReplayPage() {
  const [replay, setReplay] = useState<ReplayFile | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const code = useSearch().get("code");
  const [needLogin, setNeedLogin] = useState(false);

  // /replay?code=AbCdEf: an archived replay (ATC24Academy results link here)
  useEffect(() => {
    if (!code || !SESSION_CODE_RE.test(code)) return;
    api.replay(code).then(
      (raw) => {
        try {
          setReplay(parseReplay(raw));
        } catch (e) {
          toast((e as Error).message, "error");
        }
      },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setNeedLogin(true);
        else toast(e instanceof ApiError && e.status === 404 ? "That replay isn't available (it may have expired)" : (e as Error).message, "error", 6000);
      },
    );
  }, [code]);

  const openText = useCallback((text: string) => {
    try {
      setReplay(parseReplay(JSON.parse(text)));
    } catch (e) {
      toast(e instanceof SyntaxError ? "That file is not valid JSON" : (e as Error).message, "error", 5000);
    }
  }, []);
  const openFile = useCallback((f: File | undefined) => void f?.text().then(openText), [openText]);

  // receive a replay from the session tab that opened us (same origin only)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as { type?: string; replay?: unknown };
      if (e.origin !== location.origin || data?.type !== REPLAY_DATA) return;
      try {
        setReplay(parseReplay(data.replay));
      } catch (err) {
        toast((err as Error).message, "error");
      }
    };
    window.addEventListener("message", onMsg);
    if (window.opener) (window.opener as Window).postMessage({ type: REPLAY_READY }, location.origin);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const picker = (
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => openFile(e.target.files?.[0])} />
  );

  if (!replay)
    return (
      <div className="page">
        <Header />
        <main className="page__main">
          <h1 className="page-title">Replay</h1>
          {needLogin && (
            <p>
              <a className="btn btn--primary" href={api.loginUrl(location.pathname + location.search)}>
                Log in with Discord
              </a>{" "}
              to open replay {code}.
            </p>
          )}
          <div
            className={`dropzone${over ? " dropzone--over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              openFile(e.dataTransfer.files[0]);
            }}
          >
            <div className="stack" style={{ alignItems: "center" }}>
              <Button variant="primary" size="lg" onClick={() => fileInput.current?.click()}>
                Open replay file
              </Button>
              <span className="muted">or drop it here. Replays are downloaded when a session ends.</span>
            </div>
          </div>
          {picker}
        </main>
      </div>
    );
  return (
    <>
      <Player replay={replay} onOpen={() => fileInput.current?.click()} />
      {picker}
    </>
  );
}

function Player({ replay, onOpen }: { replay: ReplayFile; onOpen: () => void }) {
  const scope = useRef<ScopeHandle | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [version, setVersion] = useState(0);
  const apt = useScope((s) => s.apt);
  const mode = useScope((s) => s.mode);
  const frames = replay.frames;
  const frame = frames[Math.min(idx, frames.length - 1)];
  const logRef = useRef<HTMLDivElement>(null);

  // initial view: LDARPT ... GND in the events, or aircraft parked at an airport with a ground map
  useEffect(() => {
    useScope.getState().reset(null);
    setIdx(0);
    const ld = replay.events.map((e) => /LDARPT\s+(I[A-Z0-9]{3})(?:\s+(CTR|GND|TWR|AIR))?/i.exec(e.message)).find(Boolean);
    const gnd = replay.events.map((e) => /LDARPT\s+(I[A-Z0-9]{3})\s+GND/i.exec(e.message)).find(Boolean);
    let target: { apt: string; mode: "CTR" | "GND" | "TWR" } | null = null;
    if (gnd) target = { apt: gnd[1]!.toUpperCase(), mode: "GND" };
    else {
      const parked = frames[0]?.a.find((a) => a[4] <= 0 && a[5] === 0);
      const at = parked ? airports.find((x) => getGroundGraph(x.code) && airportRef(x.code) && dist(airportRef(x.code)!, { x: parked[2], y: parked[3] }) < 2) : undefined;
      if (at) target = { apt: at.code, mode: "GND" };
      else if (ld) target = { apt: ld[1]!.toUpperCase(), mode: ((ld[2] ?? "CTR").toUpperCase().replace("AIR", "CTR") as "CTR" | "GND" | "TWR") };
    }
    window.setTimeout(() => {
      if (target) switchView(target.apt, target.mode, scope.current);
      setVersion((v) => v + 1);
    }, 0);
  }, [replay, frames]);

  // playback
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let acc = 0;
    let raf = 0;
    const step = (now: number) => {
      acc += ((now - last) / 1000) * speed;
      last = now;
      if (acc >= 1) {
        const n = Math.floor(acc);
        acc -= n;
        setIdx((i) => {
          const next = Math.min(frames.length - 1, i + n);
          if (next === frames.length - 1) setPlaying(false);
          return next;
        });
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, frames.length]);

  const seek = useCallback((delta: number) => setIdx((i) => Math.max(0, Math.min(frames.length - 1, i + delta))), [frames.length]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT")) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        seek((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 60 : 10));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [seek]);

  const aircraft = useMemo((): RAircraft[] => {
    if (!frame) return [];
    const history = new Map<string, [number, number][]>();
    for (let k = 1; k <= cfg.session.trailPoints; k++) {
      const f = frames[idx - k * TRAIL_EVERY];
      if (!f) break;
      for (const a of f.a) {
        const h = history.get(a[0]) ?? [];
        h.push([a[2], a[3]]);
        history.set(a[0], h);
      }
    }
    const prev = new Map((frames[idx - 1]?.a ?? []).map((a) => [a[0], a[4]]));
    return fromReplay(frame.a, history, new Map(), prev);
  }, [frame, frames, idx]);

  const aircraftRef = useRef(aircraft);
  aircraftRef.current = aircraft;
  useEffect(() => setVersion((v) => v + 1), [aircraft]);

  const scene = useCallback((): Scene => {
    const s = useScope.getState();
    return {
      aircraft: aircraftRef.current,
      apt: s.apt,
      mode: s.mode,
      fixesAlways: s.fixesAlways,
      msa: s.msa,
      selectedId: s.selectedId,
      notes: {},
      assumed: new Set(),
      strips: {},
      routes: new Set(),
      routeFor: () => [],
      centrelines: [],
      taxiPath: null,
      pickNodes: false,
      pickedNodes: [],
      hoverNode: null,
      tags: true,
    };
  }, []);

  const t = frame?.t ?? 0;
  const shown = replay.events.filter((e) => e.t <= t);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [shown.length]);
  const jumpTo = (eventT: number) => {
    const i = frames.findIndex((f) => f.t >= eventT);
    if (i >= 0) setIdx(i);
  };

  return (
    <div className="scope-page">
      <header className="bar">
        <a className="bar__item bar__home" href="/" title="Back to the start">
          Sweatbox
        </a>
        <span className="bar__sep" />
        <span className="bar__item">Replay {replay.code}</span>
        <span className="bar__item">{stationLabel(apt, mode)}</span>
        <span className="bar__item">{replay.scriptName ?? "Nothing loaded"}</span>
        <span className="bar__item bar__value">{formatClock(frame?.e ?? 0)}</span>
        <span className="bar__spacer" />
        {(["CTR", "GND", "TWR"] as const).map((m) => (
          <button key={m} type="button" className={`barfield${mode === m ? " barfield--on" : ""}`} disabled={!apt} onClick={() => apt && switchView(apt, m, scope.current)}>
            <span className="barfield__k">{m}</span>
          </button>
        ))}
        <Button variant="ghost" onClick={onOpen}>
          Open another
        </Button>
      </header>
      <ScopeView scene={scene} version={version} handleRef={scope} onSelect={(id) => useScope.getState().select(id)} />
      <div className="replaylog" ref={logRef} aria-label="Event log">
        {shown.map((e, i) => (
          <button key={i} type="button" onClick={() => jumpTo(e.t)} style={{ color: cfg.colours.log[e.level] ?? cfg.colours.theme.text }}>
            <span className="msgs__time">{formatClock(e.atSec)}</span>
            {e.message}
          </button>
        ))}
      </div>
      <div className="replaybar">
        <Button variant="primary" onClick={() => setPlaying((p) => !p)} title="Space">
          {playing ? "Pause" : "Play"}
        </Button>
        <Button variant="ghost" onClick={() => seek(-30)} title="← = 10 s, Shift+← = 60 s">
          −30s
        </Button>
        <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={idx} onChange={(e) => setIdx(Number(e.target.value))} aria-label="Replay position" />
        <Button variant="ghost" onClick={() => seek(30)} title="→ = 10 s, Shift+→ = 60 s">
          +30s
        </Button>
        <select className="field" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <span className="data muted" style={{ width: 90, textAlign: "right" }}>
          {idx + 1}/{frames.length}
        </span>
      </div>
    </div>
  );
}
