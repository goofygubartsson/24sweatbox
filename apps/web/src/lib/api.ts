// Typed REST client for /api (same origin; the session cookie is sent automatically).
import cfg from "@sweatbox/config/public";
import type {
  AirBody,
  AircraftDTO,
  ApiError as ApiErrorBody,
  ClockBody,
  GenerateSpec,
  GndBody,
  Me,
  ScenarioInfo,
  SessionInfo,
  SessionStats,
  Snapshot,
  TwrBody,
} from "@sweatbox/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public errors?: string[],
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown, asText = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.app.apiBase}${path}`, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the Sweatbox server. Check your connection.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let e: Partial<ApiErrorBody> = {};
    try {
      e = JSON.parse(text) as ApiErrorBody;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, e.code ?? "SERVER_ERROR", e.error ?? `Request failed (${res.status})`, e.errors);
  }
  if (asText) return text as T;
  return (text ? JSON.parse(text) : undefined) as T;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request<Me>("GET", "/me"),
  logout: () => request<void>("POST", "/auth/logout"),
  devLogin: (as: "host" | "viewer", name: string) => request<Me>("POST", "/auth/dev-login", { as, name }),
  loginUrl: (next: string) => `${cfg.app.apiBase}/auth/discord?next=${enc(next)}`,

  /** Create a session; with `generate` the server also builds and loads the sweatbox. */
  createSession: (generate?: GenerateSpec) =>
    request<{ code: string; scriptName?: string; commandCount?: number }>("POST", "/sessions", generate ? { generate } : {}),
  session: (code: string) => request<SessionInfo>("GET", `/sessions/${enc(code)}`),
  state: (code: string, since: number, cmdSince: number) => request<Snapshot>("GET", `/sessions/${enc(code)}/state?since=${since}&cmdSince=${cmdSince}`),
  scenarios: () => request<ScenarioInfo[]>("GET", "/scenarios"),
  scenarioText: (name: string) => request<string>("GET", `/scenarios/${enc(name)}`, undefined, true),
  loadScript: (code: string, body: { name: string } | { text: string; label?: string } | { generate: GenerateSpec }) =>
    request<{ commandCount: number; scriptName: string }>("POST", `/sessions/${enc(code)}/script`, body),
  clock: (code: string, body: ClockBody) => request<{ running: boolean; speed: number }>("POST", `/sessions/${enc(code)}/clock`, body),
  twr: (code: string, on: boolean) => request<{ twr: boolean }>("POST", `/sessions/${enc(code)}/twr`, { on }),
  end: (code: string) => request<SessionStats>("POST", `/sessions/${enc(code)}/end`, {}),
  replayUrl: (code: string) => `${cfg.app.apiBase}/sessions/${enc(code)}/replay`,
  replay: (code: string) => request<unknown>("GET", `/sessions/${enc(code)}/replay`),

  air: (code: string, id: string, body: AirBody) => request<{ ok: true; aircraft: AircraftDTO }>("POST", `/sessions/${enc(code)}/aircraft/${enc(id)}/air`, body),
  gnd: (code: string, id: string, body: GndBody) => request<{ ok: true; aircraft: AircraftDTO }>("POST", `/sessions/${enc(code)}/aircraft/${enc(id)}/gnd`, body),
  twrAction: (code: string, id: string, body: TwrBody) =>
    request<{ ok: true; aircraft: AircraftDTO }>("POST", `/sessions/${enc(code)}/aircraft/${enc(id)}/twr`, body),
  strip: (code: string, callsign: string, key: string, value: string) =>
    request<void>("POST", `/sessions/${enc(code)}/strips`, { callsign, key, value }),
};
