// localStorage helpers: versioned keys, never throw (private mode, quota, corrupt JSON).
import cfg from "@sweatbox/config/public";

const PREFIX = `sweatbox.v${cfg.ui.storageVersion}.`;

export function loadJson<T>(key: string, fallback: T, sanitize?: (raw: unknown) => T | null): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (sanitize) return sanitize(parsed) ?? fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: per-viewer conveniences only, safe to drop
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}
