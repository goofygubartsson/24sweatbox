import { create } from "zustand";

export type ToastKind = "info" | "ok" | "error" | "host";

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

interface ToastState {
  items: ToastItem[];
  push: (text: string, kind?: ToastKind, ms?: number) => void;
}

let next = 1;

export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (text, kind = "info", ms = 3500) => {
    const id = next++;
    set((s) => ({ items: [...s.items.slice(-4), { id, text, kind }] }));
    window.setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), ms);
  },
}));

export const toast = (text: string, kind?: ToastKind, ms?: number) => useToasts.getState().push(text, kind, ms);

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
