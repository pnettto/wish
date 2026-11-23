import type { LiveMessage, RequestView } from "@web-issuer/shared";
import { isTerminalState } from "@web-issuer/shared";
import { api, ApiError, liveUrl } from "./api";

const POLL_MS = 10_000;
/** Poll even with the socket open: the server-side safety net runs on GET. */
const POLL_WITH_SOCKET_MS = 30_000;
/** Service-worker WebSockets keep the worker alive only with traffic (Chrome 116+): ping well under 30 s. */
const PING_MS = 20_000;

export interface LiveDeps {
  getSession(): Promise<string | undefined>;
  onView(view: RequestView): Promise<void>;
  onUnauthorized(): Promise<void>;
}

interface Watch {
  id: string;
  socket: WebSocket | null;
  closed: boolean;
  retry: number;
  lastPoll: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setInterval>;
  pingTimer?: ReturnType<typeof setInterval>;
}

/**
 * Follows active requests over the Worker's WebSocket with a polling
 * fallback, and hands every update to `onView`. Owned by the service worker;
 * tabs get updates through their snapshots.
 */
export class LiveTracker {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: LiveDeps) {}

  /** Follow exactly these request ids (terminal ones are dropped by the caller). */
  sync(ids: Iterable<string>): void {
    const wanted = new Set(ids);
    for (const [id, w] of this.watches) if (!wanted.has(id)) this.stop(w);
    for (const id of wanted) if (!this.watches.has(id)) void this.start(id);
  }

  stopAll(): void {
    for (const w of this.watches.values()) this.stop(w);
  }

  private async start(id: string): Promise<void> {
    const w: Watch = { id, socket: null, closed: false, retry: 0, lastPoll: 0 };
    this.watches.set(id, w);
    const session = await this.deps.getSession();
    if (!session || w.closed) {
      this.stop(w);
      return;
    }
    this.connect(w, session);
    void this.poll(w, session);
    w.pollTimer = setInterval(() => void this.poll(w, session), POLL_MS);
    w.pingTimer = setInterval(() => {
      if (w.socket?.readyState === WebSocket.OPEN) w.socket.send("ping");
    }, PING_MS);
  }

  private stop(w: Watch): void {
    w.closed = true;
    clearInterval(w.pollTimer);
    clearInterval(w.pingTimer);
    clearTimeout(w.reconnectTimer);
    try {
      w.socket?.close();
    } catch {
      // Already closed.
    }
    if (this.watches.get(w.id) === w) this.watches.delete(w.id);
  }

  private async handle(w: Watch, view: RequestView): Promise<void> {
    await this.deps.onView(view);
    if (isTerminalState(view.state)) this.stop(w);
  }

  private async poll(w: Watch, session: string): Promise<void> {
    const now = Date.now();
    if (w.closed) return;
    if (w.socket?.readyState === WebSocket.OPEN && now - w.lastPoll < POLL_WITH_SOCKET_MS) return;
    w.lastPoll = now;
    try {
      await this.handle(w, await api.request(session, w.id));
    } catch (err) {
      if (err instanceof ApiError && err.unauthorized) {
        this.stopAll();
        await this.deps.onUnauthorized();
      }
    }
  }

  private connect(w: Watch, session: string): void {
    if (w.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(liveUrl(session, w.id));
    } catch {
      return;
    }
    w.socket = socket;
    socket.onopen = () => {
      w.retry = 0;
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      try {
        const msg = JSON.parse(event.data) as LiveMessage;
        if (msg.type === "state") void this.handle(w, msg.request);
      } catch {
        // Ignore malformed messages.
      }
    };
    socket.onclose = () => {
      if (w.closed) return;
      w.retry = Math.min(w.retry + 1, 6);
      w.reconnectTimer = setTimeout(() => this.connect(w, session), 1000 * 2 ** w.retry);
    };
  }
}
