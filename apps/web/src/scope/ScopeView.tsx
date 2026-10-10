// Full-screen DPR-aware radar canvas: pan (drag), zoom (wheel, around the cursor), draggable tags,
// tag field clicks, rulers (double-click; F2 keeps, F3 clears) and ground node picking.
import { useEffect, useRef, type MutableRefObject } from "react";
import { dist, getGroundGraph, type Vec } from "@sweatbox/shared";
import { Camera } from "./camera";
import { drawScene, hitTest, invalidateMap, type Hit, type Overlay, type Ruler, type Scene, type TagField } from "./draw";

export interface ScopeHandle {
  camera: Camera;
  invalidate(): void;
  /** Current mouse position in map units (for the C command). */
  mouseWorld(): Vec | null;
  keepRuler(): void;
  clearRulers(): void;
}

interface Props {
  /** Called on every redraw to get the current scene. */
  scene: () => Scene;
  /** Bump to request a redraw when the data changes. */
  version: number;
  handleRef?: MutableRefObject<ScopeHandle | null>;
  onSelect?: (id: string) => void;
  onTagField?: (cs: string, id: string, field: TagField, button: "left" | "right") => void;
  onMapClick?: (p: Vec) => void;
  onPickNode?: (n: number) => void;
  onCameraChange?: (cam: Camera) => void;
  rulers?: boolean;
  initialView?: { cx: number; cy: number; zoom: number };
}

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
};

export function ScopeView({ scene, version, handleRef, onSelect, onTagField, onMapClick, onPickNode, onCameraChange, rulers = true, initialView }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef(new Camera());
  const hits = useRef<Hit[]>([]);
  const dirty = useRef(true);
  const ov = useRef<Overlay>({ tagOffsets: new Map(), rulers: [], liveRuler: null, mouse: null });
  const hoverNode = useRef<number | null>(null);
  const props = useRef({ scene, onSelect, onTagField, onMapClick, onPickNode, onCameraChange });
  props.current = { scene, onSelect, onTagField, onMapClick, onPickNode, onCameraChange };

  if (initialView && !(cam.current as Camera & { _init?: boolean })._init) {
    cam.current.set(initialView.cx, initialView.cy, initialView.zoom);
    (cam.current as Camera & { _init?: boolean })._init = true;
  }

  const invalidate = () => {
    dirty.current = true;
  };
  const keepRuler = () => {
    if (ov.current.liveRuler) ov.current.rulers.push(ov.current.liveRuler);
    ov.current.liveRuler = null;
    invalidate();
  };
  const clearRulers = () => {
    ov.current.rulers = [];
    invalidate();
  };

  useEffect(invalidate, [version]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      camera: cam.current,
      invalidate,
      mouseWorld: () => (ov.current.mouse ? cam.current.toWorld(ov.current.mouse.x, ov.current.mouse.y) : null),
      keepRuler,
      clearRulers,
    };
  }, [handleRef]);

  // resize + render loop
  useEffect(() => {
    const el = wrap.current!;
    const cv = canvas.current!;
    const ctx = cv.getContext("2d")!;
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cam.current.w = Math.max(1, r.width);
      cam.current.h = Math.max(1, r.height);
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      cv.style.width = `${r.width}px`;
      cv.style.height = `${r.height}px`;
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    void document.fonts?.ready.then(() => {
      invalidateMap();
      invalidate();
    });
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!dirty.current) return;
      dirty.current = false;
      const sc = props.current.scene();
      hits.current = drawScene(ctx, cam.current, { ...sc, hoverNode: hoverNode.current }, ov.current, window.devicePixelRatio || 1);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // F2 / F3 / Esc for rulers
  useEffect(() => {
    if (!rulers) return;
    const key = (e: KeyboardEvent) => {
      if (isTyping()) return;
      if (e.key === "F2") {
        e.preventDefault();
        keepRuler();
      } else if (e.key === "F3") {
        e.preventDefault();
        clearRulers();
      } else if (e.key === "Escape" && ov.current.liveRuler) {
        ov.current.liveRuler = null;
        invalidate();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [rulers]);

  // pointer interaction
  const down = useRef<{ x: number; y: number; hit: Hit | null; moved: boolean; tagStart?: [number, number] } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const updateHoverNode = (p: { x: number; y: number }) => {
    const sc = props.current.scene();
    if (!sc.pickNodes || !sc.apt) {
      hoverNode.current = null;
      return;
    }
    const g = getGroundGraph(sc.apt);
    if (!g) return;
    const w = cam.current.toWorld(p.x, p.y);
    let best: number | null = null;
    let bestD = 12 / cam.current.zoom;
    g.nodes.forEach((n, i) => {
      const d = dist(n, w);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== hoverNode.current) {
      hoverNode.current = best;
      invalidate();
    }
  };

  return (
    <div ref={wrap} className="scope-canvas-wrap">
      <canvas
        ref={canvas}
        className="scope-canvas"
        aria-label="Radar scope"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = local(e);
          if (ov.current.liveRuler) {
            // a click ends the ruler (F2 before clicking keeps it)
            ov.current.liveRuler = null;
            invalidate();
            return;
          }
          const hit = hitTest(hits.current, p.x, p.y);
          let tagStart: [number, number] | undefined;
          if (hit?.kind === "tag") {
            // current tag offset = tag box origin relative to the symbol
            const ac = props.current.scene().aircraft.find((a) => a.id === hit.id);
            const box = hits.current.find((h) => h.kind === "tag" && !h.field && h.id === hit.id);
            if (ac && box) {
              const [sx, sy] = cam.current.toScreen(ac.x, ac.y);
              tagStart = [box.x + 3 - sx, box.y + 2 - sy];
            }
          }
          down.current = { ...p, hit, moved: false, tagStart };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = local(e);
          ov.current.mouse = p;
          if (ov.current.liveRuler) {
            ov.current.liveRuler = { ...ov.current.liveRuler, b: cam.current.toWorld(p.x, p.y) };
            invalidate();
          }
          updateHoverNode(p);
          const d = down.current;
          if (!d) return;
          if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 4) return;
          d.moved = true;
          if (d.hit?.kind === "tag" && d.tagStart) {
            ov.current.tagOffsets.set(d.hit.id, [d.tagStart[0] + p.x - d.x, d.tagStart[1] + p.y - d.y]);
          } else if (d.hit?.kind !== "tag") {
            cam.current.panBy(e.movementX, e.movementY);
            props.current.onCameraChange?.(cam.current);
          }
          invalidate();
        }}
        onPointerUp={(e) => {
          const d = down.current;
          down.current = null;
          if (!d || d.moved) return;
          const p = local(e);
          const sc = props.current.scene();
          if (sc.pickNodes && hoverNode.current !== null) {
            props.current.onPickNode?.(hoverNode.current);
            return;
          }
          if (d.hit) {
            if (d.hit.field && d.hit.field !== "cs" && d.hit.field !== "type") props.current.onTagField?.(d.hit.cs, d.hit.id, d.hit.field, "left");
            else props.current.onSelect?.(d.hit.id);
            invalidate();
            return;
          }
          props.current.onMapClick?.(cam.current.toWorld(p.x, p.y));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const p = local(e);
          const hit = hitTest(hits.current, p.x, p.y);
          if (hit?.field) props.current.onTagField?.(hit.cs, hit.id, hit.field, "right");
          invalidate();
        }}
        onDoubleClick={(e) => {
          if (!rulers) return;
          const p = local(e);
          if (hitTest(hits.current, p.x, p.y)) return;
          const w = cam.current.toWorld(p.x, p.y);
          ov.current.liveRuler = { a: w, b: w } satisfies Ruler;
          invalidate();
        }}
        onWheel={(e) => {
          const p = local(e);
          cam.current.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
          props.current.onCameraChange?.(cam.current);
          invalidate();
        }}
        onPointerLeave={() => {
          ov.current.mouse = null;
        }}
      />
    </div>
  );
}
