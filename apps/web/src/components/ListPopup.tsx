import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface ListItem<T = string> {
  value: T;
  label: ReactNode;
  /** Text used for filtering (defaults to the label when it is a string). */
  text?: string;
  hint?: ReactNode;
  disabled?: boolean;
  section?: string;
}

interface Props<T> {
  items: ListItem<T>[];
  /** Anchor element rect (popup opens below it, kept on screen). */
  anchor: DOMRect | { left: number; top: number; bottom: number; right: number };
  onPick: (value: T) => void;
  onClose: () => void;
  /** Show a filter box. Enter with no match calls onCustom with the typed text. */
  filter?: boolean;
  placeholder?: string;
  onCustom?: (text: string) => void;
  initial?: T;
  width?: number;
}

/** Filterable, keyboard-driven list (up/down move, Enter picks, Esc closes). */
export function ListPopup<T>({ items, anchor, onPick, onClose, filter, placeholder, onCustom, initial, width }: Props<T>) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    if (!needle) return items;
    return items.filter((it) => (it.text ?? (typeof it.label === "string" ? it.label : String(it.value))).toUpperCase().includes(needle));
  }, [items, q]);
  const [sel, setSel] = useState(() => Math.max(0, items.findIndex((i) => i.value === initial)));
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 2 });

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = Math.min(anchor.left, window.innerWidth - r.width - 8);
    let top = anchor.bottom + 2;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, anchor.top - r.height - 2);
    left = Math.max(8, left);
    setPos({ left, top });
  }, [anchor, shown.length]);

  useEffect(() => {
    if (filter) input.current?.focus();
    else root.current?.focus();
  }, [filter]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [onClose]);

  useEffect(() => setSel((s) => Math.min(s, Math.max(0, shown.length - 1))), [shown.length]);

  const move = (d: number) => {
    if (!shown.length) return;
    let i = sel;
    for (let k = 0; k < shown.length; k++) {
      i = (i + d + shown.length) % shown.length;
      if (!shown[i]!.disabled) break;
    }
    setSel(i);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = shown[sel];
      if (it && !it.disabled && (!q || shown.length)) onPick(it.value);
      else if (onCustom && q.trim()) onCustom(q.trim());
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastSection: string | undefined;
  return (
    <div ref={root} className="listpop" style={{ ...pos, width }} tabIndex={-1} onKeyDown={onKey} role="dialog">
      {filter && (
        <input
          ref={input}
          className="field listpop__filter"
          placeholder={placeholder ?? "Type to filter"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={placeholder ?? "Filter"}
        />
      )}
      <ul className="listpop__list" role="listbox">
        {shown.length === 0 && (
          <li className="listpop__empty">{onCustom && q.trim() ? `Enter to use "${q.trim()}"` : "Nothing matches"}</li>
        )}
        {shown.map((it, i) => {
          const header = it.section && it.section !== lastSection ? it.section : null;
          lastSection = it.section;
          return (
            <div key={i}>
              {header && <li className="listpop__section">{header}</li>}
              <li
                className="listpop__item"
                role="option"
                aria-selected={i === sel}
                aria-disabled={it.disabled}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (!it.disabled) onPick(it.value);
                }}
              >
                <span>{it.label}</span>
                {it.hint !== undefined && <span className="listpop__hint">{it.hint}</span>}
              </li>
            </div>
          );
        })}
      </ul>
    </div>
  );
}
