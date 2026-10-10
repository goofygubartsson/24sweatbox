// Command line: start typing anywhere on the scope (when no input has focus). Enter runs, up recalls
// history, Backspace deletes, Ctrl+V pastes (newlines become spaces). "." + letters opens
// autocomplete (up/down select, Tab completes, Enter runs, Esc closes).
import { useEffect, useMemo, useRef, useState } from "react";
import cfg from "@sweatbox/config/public";
import { loadJson, saveJson } from "../lib/storage";
import { completions, runCommand, type CommandContext } from "./commands";
import { useScope } from "./store";

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
};

export function CommandLine({ context, enabled = true }: { context: () => CommandContext; enabled?: boolean }) {
  const text = useScope((s) => s.cmdText);
  const isHost = context().isHost;
  const [history, setHistory] = useState<string[]>(() => loadJson<string[]>("cmdHistory", [], (r) => (Array.isArray(r) ? r.filter((x) => typeof x === "string") : null)));
  const histIdx = useRef<number | null>(null);
  const [acSel, setAcSel] = useState(0);
  const [acClosed, setAcClosed] = useState(false);

  const ac = useMemo(() => {
    const m = /^\.([A-Za-z/]*)$/.exec(text);
    return m && !acClosed ? completions(text, isHost) : [];
  }, [text, isHost, acClosed]);

  const setText = (t: string) => {
    useScope.getState().set({ cmdText: t });
    setAcClosed(false);
    setAcSel(0);
  };

  const state = useRef({ text, ac, acSel, history });
  state.current = { text, ac, acSel, history };

  useEffect(() => {
    if (!enabled) return;
    const run = async (line: string) => {
      if (!line.trim()) return;
      const h = [line, ...state.current.history.filter((x) => x !== line)].slice(0, cfg.ui.commandHistory);
      setHistory(h);
      saveJson("cmdHistory", h);
      histIdx.current = null;
      setText("");
      await runCommand(line, context());
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.altKey || e.metaKey) return;
      const { text: t, ac: list, acSel: sel, history: hist } = state.current;
      if (e.ctrlKey) return; // Ctrl+V arrives as a paste event
      if (e.key === "Enter") {
        e.preventDefault();
        const pick = list[sel];
        void run(pick && t !== `.${pick.label}` ? `${pick.label}` : t);
      } else if (e.key === "Tab" && list.length) {
        e.preventDefault();
        setText(`.${list[sel]!.label} `);
        setAcClosed(true);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (list.length) {
          e.preventDefault();
          setAcSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length);
          return;
        }
        if (!hist.length) return;
        e.preventDefault();
        const cur = histIdx.current;
        const next = e.key === "ArrowUp" ? Math.min(hist.length - 1, cur === null ? 0 : cur + 1) : cur === null || cur === 0 ? null : cur - 1;
        histIdx.current = next;
        useScope.getState().set({ cmdText: next === null ? "" : hist[next]! });
      } else if (e.key === "Escape") {
        if (list.length) setAcClosed(true);
        else if (t) setText("");
      } else if (e.key === "Backspace") {
        if (!t) return;
        e.preventDefault();
        setText(t.slice(0, -1));
      } else if (e.key.length === 1 && !e.key.match(/[\u0000-\u001f]/)) {
        if (e.key === " " && !t) return;
        e.preventDefault();
        setText((t + e.key).toUpperCase());
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping()) return;
      const pasted = e.clipboardData?.getData("text") ?? "";
      if (!pasted) return;
      e.preventDefault();
      setText((state.current.text + pasted.replace(/[\r\n]+/g, " ")).toUpperCase());
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [context, enabled]);

  return (
    <div className="cmdline" aria-live="polite">
      {ac.length > 0 && (
        <ul className="cmdline__ac" role="listbox" aria-label="Commands">
          {ac.slice(0, 12).map((c, i) => (
            <li key={c.label} role="option" aria-selected={i === acSel} className="cmdline__acitem">
              <span className="cmdline__acname">.{c.label}</span>
              <span className="cmdline__acargs">{c.def.args}</span>
              <span className="cmdline__acdesc">
                {c.def.desc}
                {c.def.host && <span> · trainers</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {text && (
        <div className="cmdline__input">
          <span className="cmdline__prompt">&gt;</span>
          <span className="cmdline__text">{text}</span>
          <span className="cmdline__caret" />
        </div>
      )}
    </div>
  );
}
