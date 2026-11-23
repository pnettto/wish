import type { Env } from "./env";
import { applyPendingFailure, type PendingFailure } from "./requests";

/**
 * One instance per request id. Holds the panels' WebSockets (Hibernation API)
 * and broadcasts state changes to them. Also runs the "failed run without a
 * report" timer.
 */
export class RequestLive implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      const initial = request.headers.get("X-Initial-State");
      if (initial) server.send(decodeURIComponent(initial));
      return new Response(null, { status: 101, webSocket: client });
    }

    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/broadcast") {
      const message = await request.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // Socket already closing; it'll be cleaned up.
        }
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && pathname === "/schedule-failure") {
      const failure = (await request.json()) as PendingFailure & { at: number };
      await this.ctx.storage.put("pendingFailure", failure);
      await this.ctx.storage.setAlarm(failure.at);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const failure = await this.ctx.storage.get<PendingFailure>("pendingFailure");
    await this.ctx.storage.delete("pendingFailure");
    if (failure) await applyPendingFailure(this.env, failure);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}
