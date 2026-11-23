import type { RequestView } from "@wish/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePort, installChrome, type FakePort } from "./chrome-fake";

vi.mock("../src/config", () => ({
  API_BASE: "https://api.test",
  PREVIEW_PATTERN: "https://*.preview.test/*",
  UNDO_MS: 300,
}));

const apiMock = vi.hoisted(() => ({
  createIssue: vi.fn(),
  followup: vi.fn(),
  repos: vi.fn(async () => ({ repos: [{ fullName: "pnettto/hawk", tracked: true }] })),
  request: vi.fn(),
  integrate: vi.fn(),
}));

vi.mock("../src/background/api", () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
    get unauthorized() {
      return this.status === 401;
    }
  }
  return {
    api: apiMock,
    ApiError,
    getSession: async () => ((await chrome.storage.local.get("session")) as Record<string, string>).session,
    errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

vi.mock("../src/background/live", () => ({
  LiveTracker: class {
    sync() {}
    stopAll() {}
  },
}));

const { Hub } = await import("../src/background/hub");
const { ApiError } = await import("../src/background/api");

const PAGE = "https://hawk.example.com/notes";

const view = (over: Partial<RequestView> = {}): RequestView => ({
  id: "r1",
  clientRequestId: "c1",
  repo: "pnettto/hawk",
  title: "t",
  pageUrl: PAGE,
  dryRun: false,
  state: "created",
  issueNumber: 1,
  issueUrl: null,
  runId: null,
  runUrl: null,
  prUrl: null,
  previewUrl: null,
  prNumber: null,
  deployRunUrl: null,
  message: null,
  stalled: false,
  actionsUrl: "",
  followupCount: 0,
  awaitingSince: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const annotation = {
  comment: "Make it smaller",
  locator: "#a",
  tag: "button",
  role: "button",
  kind: "button",
  text: "Save",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  viewport: { width: 100, height: 100 },
  scroll: { x: 0, y: 0 },
};

let c: ReturnType<typeof installChrome>;

beforeEach(async () => {
  c = installChrome();
  await c.storage.local.set({ session: "s1", lastRepo: "pnettto/hawk" });
  for (const fn of Object.values(apiMock)) fn.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

/** A hub with one connected tab, a draft with one comment, and an empty message queue. */
async function setup(url = PAGE) {
  const hub = new Hub();
  await hub.ready;
  const port = fakePort(7, url);
  hub.connect(port as unknown as chrome.runtime.Port);
  port.emit({ t: "hello", url, title: "Notes" });
  port.emit({ t: "draft.add", annotation });
  await idle(hub);
  return { hub, port };
}

/** Wait for the message queue and the debounced snapshot push. */
async function idle(hub: InstanceType<typeof Hub>) {
  await (hub as unknown as { queue: Promise<unknown> }).queue;
  await new Promise((r) => setTimeout(r, 40));
  await hub.pushAll();
}

const lastSnapshot = (port: FakePort) => (port.sent.at(-1) as { s: import("../src/messages").Snapshot }).s;
const draftKey = `draft:${PAGE}`;

describe("Hub send", () => {
  it("send → undo window → commit clears the draft and records the request", async () => {
    apiMock.createIssue.mockResolvedValue(view());
    const { hub, port } = await setup();
    port.emit({ t: "send", mode: "file" });
    await idle(hub);
    expect(lastSnapshot(port).sending).not.toBeNull();
    expect((await c.storage.session.get("pendingSends")).pendingSends).toHaveProperty("7");

    await vi.waitFor(() => expect(apiMock.createIssue).toHaveBeenCalledOnce());
    await idle(hub);
    expect(apiMock.createIssue.mock.calls[0]![1]).toMatchObject({ repo: "pnettto/hawk", dryRun: true });
    expect(c.storage.local.data.has(draftKey)).toBe(false);
    expect((c.storage.local.data.get("requests") as Record<string, unknown>).r1).toBeTruthy();
    expect(c.storage.local.data.get("trackByOrigin")).toEqual({ "https://hawk.example.com": "r1" });
    expect((await c.storage.session.get("pendingSends")).pendingSends).toEqual({});
    expect(lastSnapshot(port).sending).toBeNull();
  });

  it("undo cancels the send and keeps the draft", async () => {
    const { hub, port } = await setup();
    port.emit({ t: "send", mode: "build" });
    port.emit({ t: "send.undo" });
    await idle(hub);
    await new Promise((r) => setTimeout(r, 400));
    expect(apiMock.createIssue).not.toHaveBeenCalled();
    expect(c.storage.local.data.has(draftKey)).toBe(true);
    expect((await c.storage.session.get("pendingSends")).pendingSends).toEqual({});
  });

  it("navigating during the undo window still sends the original page's draft", async () => {
    apiMock.createIssue.mockResolvedValue(view());
    const { hub, port } = await setup();
    port.emit({ t: "send", mode: "file" });
    await idle(hub);
    hub.urlChanged(7, "https://hawk.example.com/other");
    await vi.waitFor(() => expect(apiMock.createIssue).toHaveBeenCalledOnce());
    expect(apiMock.createIssue.mock.calls[0]![1]).toMatchObject({ pageUrl: PAGE });
  });

  it("closing the tab during the undo window cancels the send", async () => {
    const { hub, port } = await setup();
    port.emit({ t: "send", mode: "file" });
    await idle(hub);
    hub.tabClosed(7);
    await new Promise((r) => setTimeout(r, 400));
    expect(apiMock.createIssue).not.toHaveBeenCalled();
    expect(c.storage.local.data.has(draftKey)).toBe(true);
  });

  it("a send survives a service worker restart", async () => {
    apiMock.createIssue.mockResolvedValue(view());
    const { hub, port } = await setup();
    port.emit({ t: "send", mode: "file" });
    await idle(hub);
    // Simulate the SW dying: the old Hub's timers are gone.
    (hub as unknown as { pending: Map<number, { timer?: ReturnType<typeof setTimeout> }> }).pending.forEach((p) => clearTimeout(p.timer));

    const revived = new Hub();
    await revived.ready;
    await vi.waitFor(() => expect(apiMock.createIssue).toHaveBeenCalledOnce());
    await (revived as unknown as { queue: Promise<unknown> }).queue;
    expect(c.storage.local.data.has(draftKey)).toBe(false);
  });

  it("a failed send keeps the draft and shows a notice", async () => {
    apiMock.createIssue.mockRejectedValue(new Error("Boom."));
    const { hub, port } = await setup();
    port.emit({ t: "send", mode: "file" });
    await vi.waitFor(() => expect(apiMock.createIssue).toHaveBeenCalled());
    await idle(hub);
    expect(c.storage.local.data.has(draftKey)).toBe(true);
    expect(lastSnapshot(port).notice?.text).toMatch(/Boom\. Your comments are kept/);
  });

  it("a 401 signs out but keeps the draft", async () => {
    apiMock.createIssue.mockRejectedValue(new ApiError(401, "unauthorized", "no"));
    const { hub, port } = await setup();
    port.emit({ t: "send", mode: "file" });
    await vi.waitFor(() => expect(apiMock.createIssue).toHaveBeenCalled());
    await idle(hub);
    expect(c.storage.local.data.has("session")).toBe(false);
    expect(c.storage.local.data.has(draftKey)).toBe(true);
  });
});

describe("Hub follow-ups", () => {
  for (const state of ["running", "live", "merged"] as const) {
    it(`rejects a follow-up while the request is ${state}`, async () => {
      await c.storage.local.set({ requests: { r1: view({ state }) } });
      const { hub, port } = await setup();
      port.emit({ t: "followup", requestId: "r1" });
      await idle(hub);
      expect(lastSnapshot(port).sending).toBeNull();
      expect(lastSnapshot(port).notice?.text).toMatch(/can't be refined/);
    });
  }

  it("rejects a follow-up on a dry run", async () => {
    await c.storage.local.set({ requests: { r1: view({ state: "succeeded", dryRun: true }) } });
    const { hub, port } = await setup();
    port.emit({ t: "followup", requestId: "r1" });
    await idle(hub);
    expect(lastSnapshot(port).notice?.text).toMatch(/can't be refined/);
  });

  it("sends a follow-up for a succeeded request", async () => {
    await c.storage.local.set({ requests: { r1: view({ state: "succeeded", prNumber: 12 }) } });
    apiMock.followup.mockResolvedValue(view({ state: "created", prNumber: 12, followupCount: 1, updatedAt: 2 }));
    const { hub, port } = await setup();
    port.emit({ t: "followup", requestId: "r1" });
    await idle(hub);
    expect(lastSnapshot(port).sending?.label).toBe("Sending to PR #12…");
    await vi.waitFor(() => expect(apiMock.followup).toHaveBeenCalledOnce());
    expect(apiMock.followup.mock.calls[0]![1]).toBe("r1");
    await idle(hub);
    expect(c.storage.local.data.has(draftKey)).toBe(false);
  });
});

describe("Hub grants", () => {
  const keepOn = async () => {
    const { hub, port } = await setup();
    port.emit({ t: "site.keep", on: true });
    await idle(hub);
    return { hub, port };
  };

  it("granted: keeps the site and registers the content script", async () => {
    const { hub, port } = await keepOn();
    expect(c.windows.create).toHaveBeenCalledOnce();
    c.permissions.granted.add("https://hawk.example.com/*");
    await hub.grantResult(100, true);
    await idle(hub);
    expect(c.storage.local.data.get("keptSites")).toEqual(["https://hawk.example.com"]);
    expect(c.scripting.registerContentScripts).toHaveBeenCalled();
    expect(lastSnapshot(port).notice?.text).toMatch(/stays on/);
  });

  it("closing the grant window counts as declined", async () => {
    const { hub, port } = await keepOn();
    hub.windowClosed(100);
    await vi.waitFor(async () => {
      await idle(hub);
      expect(lastSnapshot(port).notice?.text).toMatch(/Not kept on/);
    });
    expect(c.storage.local.data.has("keptSites")).toBe(false);
  });

  it("a grant result after a service worker restart still applies", async () => {
    await keepOn();
    const revived = new Hub();
    c.permissions.granted.add("https://hawk.example.com/*");
    await revived.grantResult(100, true);
    expect(c.storage.local.data.get("keptSites")).toEqual(["https://hawk.example.com"]);
    expect((await c.storage.session.get("pendingGrants")).pendingGrants).toEqual({});
  });

  it("unknown windows are ignored", async () => {
    const hub = new Hub();
    await hub.grantResult(555, true);
    expect(c.storage.local.data.has("keptSites")).toBe(false);
  });

  it("preview grant declined still navigates to the preview", async () => {
    await c.storage.local.set({ requests: { r1: view({ state: "succeeded", previewUrl: "https://pi-1.preview.test" }) } });
    const { hub, port } = await setup();
    port.emit({ t: "preview.open", requestId: "r1", newTab: false, path: "/notes?x=1" });
    await idle(hub);
    expect(c.windows.create).toHaveBeenCalledOnce();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const done = hub.grantResult(100, false);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    vi.useRealTimers();
    expect(c.tabs.update).toHaveBeenCalledWith(7, { url: "https://pi-1.preview.test/notes?x=1" });
    expect((await c.storage.session.get("tabPreview")).tabPreview).toEqual({ 7: "r1" });
  });
});

describe("Hub toggle", () => {
  it("turning feedback mode on records the onboarding 'try it' step", async () => {
    const hub = new Hub();
    await hub.toggle({ id: 7, url: PAGE } as chrome.tabs.Tab);
    expect(await hub.isModeOn(7)).toBe(true);
    expect(c.storage.local.data.get("triedIt")).toBe(true);
  });

  it("unsupported pages don't count", async () => {
    const hub = new Hub();
    await hub.toggle({ id: 7, url: "chrome://extensions" } as chrome.tabs.Tab);
    expect(c.storage.local.data.has("triedIt")).toBe(false);
  });
});

describe("Hub navigation", () => {
  it("re-injects on same-origin navigation even if the old port is still connected", async () => {
    const { hub } = await setup();
    await c.storage.session.set({ attachedTabs: { 7: { origin: "https://hawk.example.com" } } });
    await hub.navigated(7, "https://hawk.example.com/other");
    expect(c.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ["content.js"] });
  });

  it("detaches and turns the mode off on cross-origin navigation", async () => {
    const hub = new Hub();
    await c.storage.session.set({ attachedTabs: { 7: { origin: "https://hawk.example.com" } }, modeByTab: { 7: true } });
    await hub.navigated(7, "https://elsewhere.example.org/");
    expect(c.scripting.executeScript).not.toHaveBeenCalled();
    expect((await c.storage.session.get("attachedTabs")).attachedTabs).toEqual({});
    expect(await hub.isModeOn(7)).toBe(false);
  });
});
