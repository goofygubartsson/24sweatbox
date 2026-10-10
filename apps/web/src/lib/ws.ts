// Session WebSocket client: join, ping every pingIntervalSec, reconnect with backoff, and fall back
// to REST polling of /state when the socket keeps failing.
import cfg from "@sweatbox/config/public";
import { WS_CLOSE_NO_SESSION, WS_CLOSE_NOT_LOGGED_IN, type SessionStats, type Snapshot, type WsServerMessage } from "@sweatbox/shared";
import { api, ApiError } from "./api";

export type SocketStatus = "connecting" | "open" | "polling" | "closed";

export interface SocketHandlers {
  onSnapshot: (s: Snapshot) => void;
  onEnded: (stats: SessionStats) => void;
  onGone: (reason: "expired" | "not-found" | "unauthorized") => void;
  onStatus: (s: SocketStatus) => void;
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  private ping: number | null = null;
  private poll: number | null = null;
  private retry: number | null = null;
  private failures = 0;
  private closed = false;
  private lastLogSeq = 0;
  private lastCmdId = -1;

  constructor(
    private code: string,
    private h: SocketHandlers,
  ) {}

  connect(): void {
    if (this.closed) return;
    this.h.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${cfg.app.wsPath}`);
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.stopPolling();
      ws.send(JSON.stringify({ t: "join", code: this.code }));
      this.h.onStatus("open");
      this.ping = window.setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: "ping" })), cfg.session.pingIntervalSec * 1000);
    };
    ws.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    };
    ws.onclose = (ev) => {
      if (this.ping) window.clearInterval(this.ping);
      this.ping = null;
      this.ws = null;
      if (this.closed) return;
      if (ev.code === WS_CLOSE_NO_SESSION) return this.h.onGone("not-found");
      if (ev.code === WS_CLOSE_NOT_LOGGED_IN) return this.h.onGone("unauthorized");
      if (ev.code === 1000 && ev.reason === "Session expired") return; // "gone" already delivered
      this.failures++;
      if (this.failures >= 3) this.startPolling();
      const delay = Math.min(10_000, 1000 * 2 ** Math.min(this.failures, 4));
      this.retry = window.setTimeout(() => this.connect(), delay);
    };
  }

  private dispatch(msg: WsServerMessage): void {
    if (msg.t === "snapshot") {
      if (msg.log.length) this.lastLogSeq = msg.log[msg.log.length - 1]!.seq;
      for (const c of msg.cmds) this.lastCmdId = Math.max(this.lastCmdId, c.id);
      this.h.onSnapshot(msg);
    } else if (msg.t === "ended") this.h.onEnded(msg.stats);
    else if (msg.t === "gone") this.h.onGone("expired");
  }

  private startPolling(): void {
    if (this.poll) return;
    this.h.onStatus("polling");
    const tick = async () => {
      try {
        const s = await api.state(this.code, this.lastLogSeq, this.lastCmdId < 0 ? 0 : this.lastCmdId);
        if (this.lastCmdId < 0) {
          // first poll: like a late joiner, don't replay earlier CMD lines
          this.lastCmdId = s.cmds.length ? s.cmds[s.cmds.length - 1]!.id : 0;
          s.cmds = [];
        }
        this.dispatch(s);
        if (s.ended && s.stats) this.h.onEnded(s.stats);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          this.stopPolling();
          this.h.onGone("expired");
        }
      }
    };
    void tick();
    this.poll = window.setInterval(tick, 1000);
  }

  private stopPolling(): void {
    if (this.poll) window.clearInterval(this.poll);
    this.poll = null;
  }

  close(): void {
    this.closed = true;
    this.stopPolling();
    if (this.retry) window.clearTimeout(this.retry);
    if (this.ping) window.clearInterval(this.ping);
    this.ws?.close(1000);
    this.h.onStatus("closed");
  }
}
