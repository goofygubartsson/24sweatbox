import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Anchored popover for small forms. Closes on outside click and Esc; keys never leak out. */
export function Popover({
  anchor,
  onClose,
  children,
  width,
  title,
}: {
  anchor: DOMRect;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  title?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8)),
      top: anchor.bottom + 4 + r.height > window.innerHeight - 8 ? Math.max(8, anchor.top - r.height - 4) : anchor.bottom + 4,
    });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest(".listpop")) onClose();
    };
    window.addEventListener("mousedown", down, true);
    const first = ref.current?.querySelector<HTMLElement>("input, select, button");
    first?.focus();
    return () => window.removeEventListener("mousedown", down, true);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="popover"
      style={{ ...pos, width }}
      role="dialog"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      {title && <div className="popover__title">{title}</div>}
      {children}
    </div>
  );
}
