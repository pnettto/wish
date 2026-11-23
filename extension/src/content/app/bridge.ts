import { PORT_NAME, type Snapshot, type ToBg, type ToContent } from "../../messages";

export interface Bridge {
  send(msg: ToBg): void;
  /** Keep the connection open (reconnect right away if the service worker restarts). */
  setLive(live: boolean): void;
  close(): void;
}

function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * One long-lived Port to the background. The service worker can stop when
 * idle, which disconnects the port: reconnect immediately while something is
 * in progress, otherwise on the next interaction or when the tab is shown.
 */
export function createBridge(onSnapshot: (s: Snapshot) => void, onDead: () => void): Bridge {
  let port: chrome.runtime.Port | null = null;
  let live = false;
  let closed = false;

  const hello = (): ToBg => ({ t: "hello", url: location.href, title: document.title });

  const connect = () => {
    if (closed || port) return;
    if (!extensionAlive()) {
      closed = true;
      onDead();
      return;
    }
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      closed = true;
      onDead();
      return;
    }
    port.onMessage.addListener((msg: ToContent) => {
      if (msg.t === "snapshot") onSnapshot(msg.s);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!extensionAlive()) {
        closed = true;
        onDead();
        return;
      }
      if (live) setTimeout(connect, 250);
    });
    port.postMessage(hello());
  };

  const send = (msg: ToBg) => {
    if (closed) return;
    if (!port) connect();
    try {
      port?.postMessage(msg);
    } catch {
      port = null;
      connect();
      (port as chrome.runtime.Port | null)?.postMessage(msg);
    }
  };

  // SPA navigations: tell the background about the new URL.
  let lastUrl = location.href;
  const onNav = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    send(hello());
  };
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener("navigatesuccess", onNav);
  window.addEventListener("popstate", onNav);
  window.addEventListener("hashchange", onNav);
  const onVisible = () => {
    if (document.visibilityState === "visible" && !port) connect();
  };
  document.addEventListener("visibilitychange", onVisible);

  connect();
  return {
    send,
    setLive(v) {
      live = v;
      if (v && !port) connect();
    },
    close() {
      closed = true;
      nav?.removeEventListener("navigatesuccess", onNav);
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
      document.removeEventListener("visibilitychange", onVisible);
      try {
        port?.disconnect();
      } catch {
        // Already gone.
      }
    },
  };
}
