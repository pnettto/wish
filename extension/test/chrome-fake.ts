import { vi } from "vitest";

/** Just enough of the `chrome` API for the background Hub, backed by Maps. */

type Listener<A extends unknown[]> = (...args: A) => void;

function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const list = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

export interface FakePort {
  name: string;
  sender: { tab: { id: number; windowId: number; url: string; title: string }; frameId: number; url: string };
  sent: unknown[];
  emit(msg: unknown): void;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener(l: Listener<[unknown]>): void };
  onDisconnect: { addListener(l: Listener<[]>): void };
  postMessage(msg: unknown): void;
}

export function fakePort(tabId: number, url: string, title = "Page"): FakePort {
  const msgL: Listener<[unknown]>[] = [];
  const discL: Listener<[]>[] = [];
  const port: FakePort = {
    name: "wi",
    sender: { tab: { id: tabId, windowId: 1, url, title }, frameId: 0, url },
    sent: [],
    emit: (msg) => msgL.forEach((l) => l(msg)),
    disconnect: vi.fn(() => discL.forEach((l) => l())),
    onMessage: { addListener: (l) => msgL.push(l) },
    onDisconnect: { addListener: (l) => discL.push(l) },
    postMessage: (msg) => port.sent.push(structuredClone(msg)),
  };
  return port;
}

export function installChrome() {
  const local = area();
  const session = area();
  let nextWindow = 100;
  const granted = new Set<string>();
  const chrome = {
    storage: { local, session },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
    notifications: { create: vi.fn(async () => ""), clear: vi.fn() },
    runtime: { getURL: (p: string) => `chrome-extension://id/${p}`, openOptionsPage: vi.fn(async () => {}) },
    tabs: {
      update: vi.fn(async () => ({})),
      create: vi.fn(async (o: { url: string }) => ({ id: 999, ...o })),
      get: vi.fn(async (id: number) => ({ id, index: 0 })),
      query: vi.fn(async () => []),
      reload: vi.fn(async () => {}),
    },
    windows: {
      create: vi.fn(async () => ({ id: nextWindow++ })),
      getLastFocused: vi.fn(async () => ({ focused: false })),
      update: vi.fn(async () => ({})),
    },
    scripting: {
      executeScript: vi.fn(async () => []),
      getRegisteredContentScripts: vi.fn(async () => []),
      registerContentScripts: vi.fn(async () => {}),
      unregisterContentScripts: vi.fn(async () => {}),
    },
    permissions: {
      granted,
      contains: vi.fn(async ({ origins }: { origins: string[] }) => origins.every((o) => granted.has(o))),
      remove: vi.fn(async () => true),
    },
  };
  vi.stubGlobal("chrome", chrome);
  return chrome;
}
