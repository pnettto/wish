/** Minimal async key-value store (chrome.storage.local in the extension, a Map in tests). */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export const chromeStore: KeyValueStore = {
  async get<T>(key: string) {
    const data = await chrome.storage.local.get(key);
    return data[key] as T | undefined;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

export function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get<T>(key: string) {
      const v = data.get(key);
      return (v === undefined ? undefined : structuredClone(v)) as T | undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

export const KEYS = {
  session: "session",
  lastRepo: "lastRepo",
  dryRun: "dryRun",
  /** Map of request id → RequestView for requests still being followed. */
  requests: "requests",
  /** Map of page key → request id shown in the Track view. */
  trackByPage: "trackByPage",
  draft: (pageKey: string) => `draft:${pageKey}`,
} as const;
