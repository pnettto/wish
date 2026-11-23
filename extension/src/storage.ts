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
  /** Default repository for new drafts. */
  lastRepo: "lastRepo",
  /** Map of repo → "file" | "build" (File issue only / File & build). */
  sendModeByRepo: "sendModeByRepo",
  /** Map of request id → RequestView for requests still being followed. */
  requests: "requests",
  /** Map of page origin → request id shown in the dock on that site. */
  trackByOrigin: "trackByOrigin",
  /** Origins with "Keep on for this site". */
  keptSites: "keptSites",
  /** Map of origin → DockPrefs. */
  dockByOrigin: "dockByOrigin",
  /** "Don't show again" on the preview notice. */
  previewNoticeOff: "previewNoticeOff",
  /** Onboarding: the user skipped "Allow preview sites". */
  previewSkipped: "previewSkipped",
  /** Onboarding: feedback mode was turned on at least once. */
  triedIt: "triedIt",
  draft: (pageKey: string) => `draft:${pageKey}`,
} as const;

/** Keys in chrome.storage.session (cleared when the browser closes). */
export const SESSION_KEYS = {
  /** Map of tab id → feedback mode on. */
  modeByTab: "modeByTab",
  /** Map of tab id → { origin } of tabs the content script was injected into. */
  attachedTabs: "attachedTabs",
  /** Request ids whose preview notice was shown this session. */
  previewNoticeSeen: "previewNoticeSeen",
  /** Map of tab id → request id, for tabs opened on a preview. */
  tabPreview: "tabPreview",
  /** Cached /repos response. */
  repos: "repos",
  /** Map of tab id → send waiting in its undo window (survives SW restarts). */
  pendingSends: "pendingSends",
  /** Map of window id → open permission grant popup and what to do after it. */
  pendingGrants: "pendingGrants",
} as const;

export const sessionStore: KeyValueStore = {
  async get<T>(key: string) {
    const data = await chrome.storage.session.get(key);
    return data[key] as T | undefined;
  },
  async set(key, value) {
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.session.remove(key);
  },
};
