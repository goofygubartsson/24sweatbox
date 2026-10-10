// A tiny History API router: five pages don't need a routing library.
import { useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
window.addEventListener("popstate", notify);

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  notify();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Current pathname (re-renders on navigation). */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export function useSearch(): URLSearchParams {
  const s = useSyncExternalStore(subscribe, () => location.search);
  return new URLSearchParams(s);
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      aria-current={location.pathname === to ? "page" : undefined}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
