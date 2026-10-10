import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadJson, saveJson } from "../lib/storage";

interface Props {
  /** Storage id: position and minimised state are remembered per id. */
  id: string;
  title: ReactNode;
  defaultPos: { x: number; y: number };
  width?: number | string;
  onClose?: () => void;
  minimisable?: boolean;
  actions?: ReactNode;
  /** Resizable from the bottom-right corner (the size is remembered; double-click the corner to reset). */
  resizable?: boolean;
  children: ReactNode;
}

interface Saved {
  x: number;
  y: number;
  min: boolean;
  /** Body size set by resizing (CSS px). */
  w?: number;
  h?: number;
}

const MIN_W = 160;
const MIN_H = 60;

const clampPos = (x: number, y: number) => ({
  x: Math.max(0, Math.min(window.innerWidth - 120, x)),
  y: Math.max(48, Math.min(window.innerHeight - 28, y)),
});

/** Floating panel: draggable by its header, minimisable, closable, remembers its position. */
export function Panel({ id, title, defaultPos, width, onClose, minimisable = true, actions, resizable = false, children }: Props) {
  const [st, setSt] = useState<Saved>(() =>
    loadJson<Saved>(`panel.${id}`, { ...defaultPos, min: false }, (raw) => {
      const r = raw as Partial<Saved>;
      if (typeof r?.x !== "number" || typeof r?.y !== "number") return null;
      const size = typeof r.w === "number" && typeof r.h === "number" ? { w: r.w, h: r.h } : {};
      return { x: r.x, y: r.y, min: Boolean(r.min), ...size };
    }),
  );
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = body.current;
    if (!el) return;
    const start = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
    const move = (ev: PointerEvent) =>
      setSt((s) => ({ ...s, w: Math.max(MIN_W, start.w + ev.clientX - start.x), h: Math.max(MIN_H, start.h + ev.clientY - start.y) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => saveJson(`panel.${id}`, st), [id, st]);

  const onMove = useCallback((e: PointerEvent) => {
    if (!drag.current) return;
    const p = clampPos(e.clientX - drag.current.dx, e.clientY - drag.current.dy);
    setSt((s) => ({ ...s, ...p }));
  }, []);
  const onUp = useCallback(() => {
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }, [onMove]);

  const pos = clampPos(st.x, st.y);
  return (
    <section className={`panel${st.min ? " panel--min" : ""}`} style={{ left: pos.x, top: pos.y, width }} aria-label={typeof title === "string" ? title : undefined}>
      <header
        className="panel__head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
        onDoubleClick={() => minimisable && setSt((s) => ({ ...s, min: !s.min }))}
      >
        <span className="panel__title">{title}</span>
        {actions}
        {minimisable && (
          <button type="button" className="iconbtn" aria-label={st.min ? "Expand" : "Minimise"} onClick={() => setSt((s) => ({ ...s, min: !s.min }))}>
            {st.min ? "▢" : "–"}
          </button>
        )}
        {onClose && (
          <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
      </header>
      {!st.min && (
        <div ref={body} className="panel__body" style={resizable && st.w ? { width: st.w, height: st.h } : undefined}>
          {children}
        </div>
      )}
      {resizable && !st.min && (
        <div
          className="panel__grip"
          title="Drag to resize, double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={() => setSt(({ w: _w, h: _h, ...s }) => s)}
        />
      )}
    </section>
  );
}
