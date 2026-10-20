// The radar scope page for a sweatbox session: /s/:code.
import { useCallback, useEffect, useRef, useState } from "react";
import cfg from "@sweatbox/config/public";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { navigate } from "../lib/router";
import { SessionSocket } from "../lib/ws";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { toast } from "../components/Toast";
import { ScopeView, type ScopeHandle } from "../scope/ScopeView";
import type { Scene, TagField } from "../scope/draw";
import { useScope } from "../scope/store";
import { HostBar } from "../scope/hostbar/HostBar";
import { HostPanel } from "../scope/HostPanel";
import { StripLists } from "../scope/StripLists";
import { Widgets } from "../scope/Widgets";
import { EndScreen } from "../scope/EndScreen";
import { MessageArea } from "../scope/MessageArea";
import { CommandLine } from "../scope/CommandLine";
import { runCommand, type CommandContext } from "../scope/commands";
import { routeFor } from "../scope/routes";
import { switchView } from "../scope/views";
import type { RAircraft } from "../scope/model";
import { act } from "../scope/hostbar/act";
import type { AcademyView } from "@sweatbox/shared";

const SCENARIO_META = new RegExp(cfg.data.scenarioMetaRegex);
const VIEW_FOR_POSITION: Record<string, "CTR" | "GND" | "TWR"> = { DEL: "GND", GND: "GND", TWR: "TWR", APP: "CTR", CTR: "CTR" };

export function ScopePage({ code }: { code: string }) {
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  const scope = useRef<ScopeHandle | null>(null);
  const version = useScope((s) => s.version);
  const mode = useScope((s) => s.mode);
  const hostPanel = useScope((s) => s.hostPanel);
  const ended = useScope((s) => s.ended);
  const messages = useScope((s) => s.messages);
  const academyId = useScope((s) => s.snap?.academyId ?? null);
  const [academy, setAcademy] = useState<AcademyView | null>(null);
  const [endClosed, setEndClosed] = useState(false);
  const [scriptErrors, setScriptErrors] = useState<string[] | null>(null);
  const cmdSeen = useRef(new Set<number>());

  useEffect(() => {
    useScope.getState().reset(code);
    cmdSeen.current.clear();
    setEndClosed(false);
  }, [code]);

  const loadText = useCallback(
    async (text: string, label: string): Promise<void> => {
      try {
        const r = await api.loadScript(code, { text, label });
        useScope.getState().say(`Loaded ${label} (${r.commandCount} commands)`);
      } catch (e) {
        const err = e as ApiError;
        if (err.errors?.length) setScriptErrors(err.errors);
        else toast(err.message, "error");
      }
    },
    [code],
  );

  const loadClipboard = useCallback(async () => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast("The browser blocked clipboard access.", "error", 6000);
      return;
    }
    if (!text.trim()) return void toast("The clipboard is empty", "error");
    await loadText(text, "Clipboard");
  }, [loadText]);

  const context = useCallback(
    (): CommandContext => ({ isHost: Boolean(me?.isHost), code, scope: scope.current, loadClipboard }),
    [me?.isHost, code, loadClipboard],
  );

  // an ATC24Academy assessment: its details (the host panel) and the student's way back
  useEffect(() => {
    if (!academyId) return setAcademy(null);
    let live = true;
    api.academySession(academyId).then(
      (v) => live && setAcademy(v),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [academyId, ended]);

  // session socket
  useEffect(() => {
    if (!me) return;
    const sock = new SessionSocket(code, {
      onSnapshot: (s) => {
        useScope.getState().applySnapshot(s);
        // nothing on the scope yet: open the sweatbox's own airport and position (e.g. TWR-IRFD-25)
        const meta = s.scriptName ? SCENARIO_META.exec(s.scriptName) : null;
        if (meta && !useScope.getState().apt) switchView(meta[2]!, VIEW_FOR_POSITION[meta[1]!] ?? "CTR", scope.current);
        // script CMD broadcast: run each id exactly once, without touching what the user is typing
        for (const c of s.cmds) {
          if (cmdSeen.current.has(c.id)) continue;
          cmdSeen.current.add(c.id);
          void runCommand(c.text, { ...context(), fromScript: true });
        }
      },
      onEnded: (stats) => useScope.getState().set({ ended: stats }),
      onGone: (reason) => {
        toast(reason === "not-found" ? `No session ${code}` : reason === "unauthorized" ? "Log in to join" : "The session has expired", "error", 5000);
        navigate("/");
      },
      onStatus: (s) => useScope.getState().set({ socket: s }),
    });
    sock.connect();
    return () => sock.close();
  }, [code, me, context]);

  const scene = useCallback((): Scene => {
    const s = useScope.getState();
    const sel = s.aircraft.find((a) => a.id === s.selectedId);
    const centrelines: string[] = [];
    for (const [apt, rc] of Object.entries(s.rwycfg)) if (rc !== "disabled") for (const d of rc.arr) centrelines.push(`${apt}-${d}`);
    return {
      aircraft: s.aircraft,
      apt: s.apt,
      mode: s.mode,
      fixesAlways: s.fixesAlways,
      msa: s.msa,
      selectedId: s.selectedId,
      notes: s.notes,
      assumed: s.assumed,
      strips: s.strips,
      routes: s.routes,
      routeFor: (a: RAircraft) => routeFor(a),
      centrelines,
      taxiPath: sel?.dto?.gnd?.path ?? null,
      pickNodes: s.pick !== null,
      pickedNodes: s.pick?.nodes ?? [],
      hoverNode: null,
      tags: true,
    };
  }, []);

  const onTagField = useCallback(
    (cs: string, _id: string, field: TagField, button: "left" | "right") => {
      const st = useScope.getState();
      const typed = st.cmdText.trim();
      const strip = (key: string, value: string) => void act(() => api.strip(code, cs, key, value));
      if (field === "cs" && button === "right") {
        st.say(`${cs} ${st.toggleAssumed(cs) ? "assumed" : "released"}`);
      } else if (field === "dest" && button === "right") {
        st.toggleRoute(cs);
      } else if (field === "rmk") {
        // the remark is shared (the strip's RMK): type it, click RMK; right-click clears it
        if (button === "right") strip("rmk", "");
        else if (typed) {
          strip("rmk", typed.toUpperCase());
          st.set({ cmdText: "" });
        }
      } else if (field === "cfl" || field === "asp" || field === "ahdg") {
        if (button === "right") {
          st.setNote(cs, field, null);
          if (field === "cfl") strip("clmb", "");
        } else if (typed) {
          const level = field === "cfl" && /^\d{1,3}$/.test(typed) ? typed.padStart(3, "0") : typed;
          st.setNote(cs, field, level);
          // the tag's CFL is the strip's CLMB (cleared climb), and the other way round
          if (field === "cfl" && /^\d{3}$/.test(level)) strip("clmb", String(Number(level) * 100));
          st.set({ cmdText: "" });
        }
      }
    },
    [code],
  );

  const onPickNode = useCallback(
    (n: number) => {
      const st = useScope.getState();
      const pick = st.pick;
      const sel = st.aircraft.find((a) => a.id === st.selectedId);
      if (!pick || !sel) return;
      if (pick.kind === "taxi") st.set({ pick: { ...pick, nodes: pick.nodes.includes(n) ? pick.nodes.filter((x) => x !== n) : [...pick.nodes, n] } });
      else if (pick.kind === "push") {
        st.set({ pick: null });
        void act(() => api.gnd(code, sel.id, { action: "push", to: n }));
      }
    },
    [code],
  );

  if (!loaded) return <div className="scope-page" />;
  if (!me) {
    return (
      <main className="home">
        <div className="home__center">
          <h1 className="home__title">ATC24Academy Sweatbox</h1>
          <div className="home__login">
            <a className="btn btn--primary btn--lg" href={api.loginUrl(location.pathname)}>
              Log in with Discord
            </a>
            <p className="muted" style={{ margin: 0 }}>
              to join session {code}
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="scope-page">
      <HostBar me={me} code={code} />
      <ScopeView
        scene={scene}
        version={version}
        handleRef={scope}
        onSelect={(id) => useScope.getState().select(id)}
        onTagField={onTagField}
        onPickNode={onPickNode}
      />
      {(mode === "GND" || mode === "TWR") && <StripLists code={code} />}
      <Widgets />
      {hostPanel && me.isHost && <HostPanel code={code} academy={academy} onAcademy={setAcademy} />}
      <div className="scope-bottomleft">
        <MessageArea messages={messages} />
        <CommandLine context={context} />
      </div>
      {me.reauth && (
        <div className="banner" role="alert">
          {cfg.auth.reauthBannerText}
          <a className="btn" href={api.loginUrl(location.pathname)}>
            Log in again
          </a>
        </div>
      )}
      {ended && !endClosed && <EndScreen stats={ended} onClose={() => setEndClosed(true)} returnUrl={!me.isHost ? academy?.returnUrl : null} />}
      {scriptErrors && (
        <Modal title="The script has errors" onClose={() => setScriptErrors(null)} footer={<Button onClick={() => setScriptErrors(null)}>Close</Button>}>
          <pre className="data" style={{ margin: 0, whiteSpace: "pre-wrap", color: cfg.colours.log.error }}>
            {scriptErrors.join("\n")}
          </pre>
        </Modal>
      )}
    </div>
  );
}
