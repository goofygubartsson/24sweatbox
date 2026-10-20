// WebSocket /api/ws (spec 15.5): join a session, keep it alive with pings, receive snapshots.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "@sweatbox/config";
import { WS_CLOSE_NO_SESSION, WS_CLOSE_NOT_LOGGED_IN, WsClientMessage, type WsServerMessage } from "@sweatbox/shared";
import type { Deps } from "./deps";
import type { UserRow } from "./db";
import type { Viewer } from "./sim/session";
import { originAllowed } from "./app";

interface Conn {
  ws: WebSocket;
  userId: string;
  code: string | null;
  viewer: Viewer;
  alive: boolean;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function attachWebSocket(server: Server, deps: Deps): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const byCode = new Map<string, Set<Conn>>();
  const send = (c: Conn, msg: WsServerMessage) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== config.app.wsPath && url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? cookieValue(req.headers.cookie, config.auth.cookieName);
    const user: UserRow | undefined = deps.auth.userForToken(token) ?? deps.auth.fakeUser();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!user || !user.in_guild) {
        ws.close(WS_CLOSE_NOT_LOGGED_IN, "Not logged in");
        return;
      }
      onConnection(ws, user);
    });
  });

  function leave(c: Conn) {
    if (c.code) byCode.get(c.code)?.delete(c);
  }

  function onConnection(ws: WebSocket, user: UserRow) {
    const c: Conn = { ws, userId: user.id, code: null, viewer: { host: Boolean(user.is_host), lastLogSeq: 0, lastCmdId: 0 }, alive: true };
    ws.on("pong", () => (c.alive = true));
    ws.on("close", () => leave(c));
    ws.on("message", (raw) => {
      let msg: WsClientMessage;
      try {
        const parsed = WsClientMessage.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) return;
        msg = parsed.data;
      } catch {
        return;
      }
      const u = deps.store.getUser(c.userId);
      if (!u) {
        ws.close(WS_CLOSE_NOT_LOGGED_IN, "Not logged in");
        return;
      }
      c.viewer.host = Boolean(u.is_host);
      if (msg.t === "join") {
        const s = deps.sessions.get(msg.code);
        if (!s || !deps.academy.canJoin(s, u)) {
          ws.close(WS_CLOSE_NO_SESSION, "No such session");
          return;
        }
        leave(c);
        c.code = s.code;
        // late joiners don't get earlier CMD lines
        c.viewer = { host: Boolean(u.is_host), lastLogSeq: 0, lastCmdId: s.cmdSeq };
        if (!byCode.has(s.code)) byCode.set(s.code, new Set());
        byCode.get(s.code)!.add(c);
        markPresent(s.code, u);
        send(c, s.snapshotFor(c.viewer));
        if (s.ended && s.finalStats) send(c, { t: "ended", stats: s.finalStats });
        return;
      }
      if (msg.t === "ping" && c.code) markPresent(c.code, u);
    });
  }

  function markPresent(code: string, u: UserRow) {
    const s = deps.sessions.get(code);
    if (!s) return;
    const now = Date.now();
    const prev = s.clients.get(u.id);
    s.clients.set(u.id, { userId: u.id, name: u.display_name, user: u.username, host: Boolean(u.is_host), firstSeen: prev?.firstSeen ?? now, lastSeen: now });
    s.touch();
  }

  deps.sessions.onTick((s) => {
    const conns = byCode.get(s.code);
    if (!conns?.size) return;
    const base = s.snapshotBase();
    for (const c of conns) send(c, s.snapshotFor(c.viewer, base));
  });
  deps.sessions.onEnd((s, stats) => {
    for (const c of byCode.get(s.code) ?? []) send(c, { t: "ended", stats });
  });
  deps.sessions.onGone((code) => {
    for (const c of byCode.get(code) ?? []) {
      send(c, { t: "gone" });
      c.ws.close(1000, "Session expired");
    }
    byCode.delete(code);
  });

  // drop dead connections
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const c = [...byCode.values()].flatMap((s) => [...s]).find((x) => x.ws === ws);
      if (c && !c.alive) {
        ws.terminate();
        continue;
      }
      if (c) c.alive = false;
      ws.ping();
    }
  }, 30_000);

  return {
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, "Server shutting down");
      wss.close();
    },
  };
}
