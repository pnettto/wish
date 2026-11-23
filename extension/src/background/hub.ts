import { isTerminalState, type RepoInfo, type RequestView } from "@wish/shared";
import { PREVIEW_PATTERN, UNDO_MS } from "../config";
import { DraftStore, pageKey, type Draft } from "../drafts";
import { PORT_NAME, type DockPrefs, type Notice, type Snapshot, type ToBg, type ToContent } from "../messages";
import {
  canFollowUp,
  matchesPattern,
  originOf,
  originPattern,
  pageSupport,
  pathOf,
  previewRequestFor,
  previewUrlFor,
  productionUrlFor,
  type SendMode,
} from "../page";
import { chromeStore, KEYS, SESSION_KEYS, sessionStore } from "../storage";
import { loadRequests, saveRequest, type RequestMap } from "../tracking";
import { api, ApiError, errorText, getSession } from "./api";
import { hasOrigins, inject, reconcileRegistrations } from "./injection";
import { LiveTracker } from "./live";
import { buildSnapshot, defaultRepo, watchedIds } from "./state";

const drafts = new DraftStore(chromeStore);
const REPOS_TTL_MS = 10 * 60 * 1000;

interface TabConn {
  port: chrome.runtime.Port;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  last: Snapshot | null;
}

type SendKind = { t: "issue"; mode: SendMode } | { t: "followup"; requestId: string };

interface PendingSend {
  kind: SendKind;
  label: string;
  undoUntil: number;
  /** Page URL of the draft being sent, fixed at Send time (the tab may navigate during the undo window). */
  draftUrl: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** What survives a service worker restart (chrome.storage.session). */
type StoredSend = Omit<PendingSend, "timer">;

/** What to do once the permission popup closes. */
type GrantThen =
  | { kind: "keep"; tabId: number; origin: string }
  | { kind: "preview"; tabId: number; url: string; newTab: boolean; requestId: string };

interface PendingGrant {
  windowId: number;
  then: GrantThen;
}

async function getMap<T>(store: typeof chromeStore, key: string): Promise<Record<string, T>> {
  return (await store.get<Record<string, T>>(key)) ?? {};
}

/**
 * The background side of the in-page UI: one Port per tab, a Snapshot per
 * tab pushed on every change, and all API calls (the only place with the
 * session token).
 */
export class Hub {
  private readonly conns = new Map<number, TabConn>();
  private readonly pending = new Map<number, PendingSend>();
  private readonly notices = new Map<number, Notice>();
  private readonly grants = new Map<number, PendingGrant>();
  private repos: { list: RepoInfo[] | null; error: string | null; at: number; loading: Promise<void> | null } = {
    list: null,
    error: null,
    at: 0,
    loading: null,
  };
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  readonly live: LiveTracker;

  /** Resolves once pending sends and grants from before a service worker restart are restored. */
  readonly ready: Promise<void>;

  constructor() {
    this.live = new LiveTracker({
      getSession,
      onView: (view) => this.recordView(view),
      onUnauthorized: () => this.unauthorized(),
    });
    this.ready = this.restore().catch((err) => console.error("restore", err));
  }

  /**
   * The service worker can be restarted at any time. Pending sends (undo
   * window) and open grant popups are mirrored in session storage; resume them
   * here. A send whose undo window already passed is committed right away
   * (clientRequestId keeps that idempotent).
   */
  private async restore(): Promise<void> {
    const sends = await getMap<StoredSend>(sessionStore, SESSION_KEYS.pendingSends);
    for (const [tabId, s] of Object.entries(sends)) {
      const id = Number(tabId);
      if (this.pending.has(id)) continue;
      this.schedule(id, { ...s, timer: undefined });
    }
    const grants = await getMap<PendingGrant>(sessionStore, SESSION_KEYS.pendingGrants);
    for (const g of Object.values(grants)) if (!this.grants.has(g.windowId)) this.grants.set(g.windowId, g);
    if (Object.keys(sends).length > 0) this.schedulePush();
  }

  // -------------------------------------------------------------------------
  // Connections

  connect(port: chrome.runtime.Port): void {
    if (port.name !== PORT_NAME) return;
    const tab = port.sender?.tab;
    if (!tab?.id || port.sender?.frameId !== 0) {
      port.disconnect();
      return;
    }
    const conn: TabConn = { port, tabId: tab.id, windowId: tab.windowId, url: port.sender?.url ?? tab.url ?? "", title: tab.title ?? "", last: null };
    this.conns.get(tab.id)?.port.disconnect();
    this.conns.set(tab.id, conn);
    port.onMessage.addListener((msg: ToBg) => {
      this.enqueue(async () => {
        if (this.conns.get(conn.tabId) !== conn) return;
        try {
          await this.handle(conn, msg);
        } catch (err) {
          this.setNotice(conn.tabId, { text: errorText(err), tone: "error" });
        }
        this.schedulePush();
      });
    });
    port.onDisconnect.addListener(() => {
      if (this.conns.get(conn.tabId) === conn) this.conns.delete(conn.tabId);
      this.schedulePush();
    });
  }

  tabClosed(tabId: number): void {
    const p = this.pending.get(tabId);
    if (p?.timer) {
      // Closing the tab during the undo window cancels the send (the draft stays).
      clearTimeout(p.timer);
      this.dropPending(tabId, p);
    }
    this.notices.delete(tabId);
    void this.updateSessionMap<boolean>(SESSION_KEYS.modeByTab, (m) => delete m[tabId]);
    void this.updateSessionMap<unknown>(SESSION_KEYS.attachedTabs, (m) => delete m[tabId]);
    void this.updateSessionMap<string>(SESSION_KEYS.tabPreview, (m) => delete m[tabId]);
  }

  /** SPA navigation (or a hello from the content script) changed the tab's URL. */
  urlChanged(tabId: number, url: string): void {
    const conn = this.conns.get(tabId);
    if (!conn || conn.url === url) return;
    conn.url = url;
    this.schedulePush();
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn, fn).catch((err) => console.error(err));
  }

  // -------------------------------------------------------------------------
  // Snapshots

  schedulePush(): void {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.pushAll(), 30);
  }

  async pushAll(): Promise<void> {
    await this.ready;
    const local = await chrome.storage.local.get([
      KEYS.session,
      KEYS.requests,
      KEYS.trackByOrigin,
      KEYS.sendModeByRepo,
      KEYS.lastRepo,
      KEYS.keptSites,
      KEYS.dockByOrigin,
      KEYS.previewNoticeOff,
    ]);
    const session = await chrome.storage.session.get([SESSION_KEYS.modeByTab, SESSION_KEYS.previewNoticeSeen]);
    const signedIn = !!local[KEYS.session];
    if (signedIn && this.conns.size > 0) this.ensureRepos();
    const modeByTab = (session[SESSION_KEYS.modeByTab] ?? {}) as Record<string, boolean>;
    const watched = new Set<string>();
    const requests = (local[KEYS.requests] ?? {}) as RequestMap;

    for (const conn of this.conns.values()) {
      const p = this.pending.get(conn.tabId);
      const s = buildSnapshot({
        url: conn.url,
        signedIn,
        mode: !!modeByTab[conn.tabId],
        repos: this.repos.list,
        reposError: this.repos.error,
        draft: (await drafts.load(conn.url)) ?? null,
        requests,
        trackByOrigin: (local[KEYS.trackByOrigin] ?? {}) as Record<string, string>,
        sendModeByRepo: (local[KEYS.sendModeByRepo] ?? {}) as Record<string, SendMode>,
        lastRepo: (local[KEYS.lastRepo] as string | undefined) ?? null,
        sending: p ? { undoUntil: p.undoUntil, label: p.label } : null,
        keptSites: (local[KEYS.keptSites] ?? []) as string[],
        notice: this.notices.get(conn.tabId) ?? null,
        dockByOrigin: (local[KEYS.dockByOrigin] ?? {}) as Record<string, DockPrefs>,
        previewNoticeOff: !!local[KEYS.previewNoticeOff],
        previewNoticeSeen: (session[SESSION_KEYS.previewNoticeSeen] ?? []) as string[],
      });
      conn.last = s;
      for (const id of watchedIds(s)) if (!isTerminalState(requests[id]!.state)) watched.add(id);
      const msg: ToContent = { t: "snapshot", s };
      try {
        conn.port.postMessage(msg);
      } catch {
        this.conns.delete(conn.tabId);
      }
    }
    if (signedIn) this.live.sync(watched);
    else this.live.sync([]);
  }

  private ensureRepos(force = false): void {
    if (this.repos.loading) return;
    if (!force && this.repos.list && Date.now() - this.repos.at < REPOS_TTL_MS) return;
    if (!force && this.repos.error && Date.now() - this.repos.at < 30_000) return;
    this.repos.loading = (async () => {
      const session = await getSession();
      if (!session) return;
      try {
        const res = await api.repos(session);
        this.repos.list = res.repos;
        this.repos.error = null;
      } catch (err) {
        if (err instanceof ApiError && err.unauthorized) await this.unauthorized();
        else this.repos.error = errorText(err);
      } finally {
        this.repos.at = Date.now();
      }
    })().finally(() => {
      this.repos.loading = null;
      this.schedulePush();
    });
  }

  resetRepos(): void {
    this.repos = { list: null, error: null, at: 0, loading: null };
  }

  // -------------------------------------------------------------------------
  // Requests

  /** Store an update; notify when a request reaches an outcome. */
  async recordView(view: RequestView): Promise<void> {
    const before = (await loadRequests(chromeStore))[view.id];
    const all = await saveRequest(chromeStore, view);
    const now = all[view.id];
    if (!now || now !== view) {
      // Stale update ignored.
      if (all[view.id]?.updatedAt !== view.updatedAt) return;
    }
    if (before && !isTerminalState(before.state) && isTerminalState(view.state)) await this.finished(view);
    this.schedulePush();
  }

  private async finished(view: RequestView): Promise<void> {
    const ok = view.state === "succeeded" || view.state === "live" || view.state === "untracked" || view.state === "merged";
    await chrome.action.setBadgeBackgroundColor({ color: ok ? "#4c7a5a" : "#9a6b2f" });
    await chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
    if (await this.isBeingWatched(view.id)) return;
    const message =
      view.state === "succeeded" && view.previewUrl
        ? "Preview ready."
        : view.state === "live"
          ? "Live in production."
          : view.state === "succeeded"
            ? "Changes are ready in a pull request."
            : view.state === "checks_failed"
              ? "Preview ready, but checks are failing."
              : view.state === "no_changes"
                ? "No code changes were made. Add detail to try again."
                : view.state === "failed"
                  ? "The automation failed."
                  : view.state === "deploy_failed"
                    ? "The production deploy failed."
                    : (view.message ?? "Done.");
    try {
      await chrome.notifications.create(`wi:${view.id}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: view.title,
        message,
        priority: 1,
      });
    } catch {
      // Notifications disabled; the badge still shows.
    }
  }

  /** A focused tab already shows this request (no system notification needed). */
  private async isBeingWatched(requestId: string): Promise<boolean> {
    try {
      const win = await chrome.windows.getLastFocused();
      if (!win.focused || win.id === undefined) return false;
      const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
      const conn = active?.id !== undefined ? this.conns.get(active.id) : undefined;
      return !!conn?.last && watchedIds(conn.last).includes(requestId);
    } catch {
      return false;
    }
  }

  async notificationClicked(id: string): Promise<void> {
    if (!id.startsWith("wi:")) return;
    const requestId = id.slice(3);
    chrome.notifications.clear(id);
    for (const conn of this.conns.values()) {
      if (conn.last && watchedIds(conn.last).includes(requestId)) {
        await chrome.tabs.update(conn.tabId, { active: true });
        await chrome.windows.update(conn.windowId, { focused: true });
        return;
      }
    }
    const r = (await loadRequests(chromeStore))[requestId];
    if (r) await chrome.tabs.create({ url: this.bestUrl(r) });
  }

  private bestUrl(r: RequestView): string {
    if (r.previewUrl && (r.state === "succeeded" || r.state === "checks_failed")) {
      return previewUrlFor(r, pathOf(r.pageUrl)) ?? r.pageUrl;
    }
    return r.pageUrl;
  }

  async unauthorized(): Promise<void> {
    await chromeStore.remove(KEYS.session);
    this.resetRepos();
    this.live.stopAll();
    this.schedulePush();
  }

  /** Alarm safety net: poll active requests even when no tab is open. */
  async poll(): Promise<void> {
    const session = await getSession();
    if (!session) return;
    for (const r of Object.values(await loadRequests(chromeStore))) {
      if (isTerminalState(r.state)) continue;
      try {
        await this.recordView(await api.request(session, r.id));
      } catch (err) {
        if (err instanceof ApiError && err.unauthorized) return this.unauthorized();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mode / activation

  async setMode(tabId: number, on: boolean): Promise<void> {
    await this.updateSessionMap<boolean>(SESSION_KEYS.modeByTab, (m) => {
      if (on) m[tabId] = true;
      else delete m[tabId];
    });
    this.schedulePush();
  }

  async isModeOn(tabId: number): Promise<boolean> {
    return !!(await getMap<boolean>(sessionStore, SESSION_KEYS.modeByTab))[tabId];
  }

  hasConnection(tabId: number): boolean {
    return this.conns.has(tabId);
  }

  /** Toolbar click / ⌥⇧F: toggle feedback mode, injecting the content script if needed. */
  async toggle(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id === undefined) return;
    const url = tab.url ?? tab.pendingUrl ?? "";
    const support = pageSupport(url);
    if (!support.ok) {
      await this.tell(tab.id, support.reason);
      return;
    }
    const on = !(await this.isModeOn(tab.id));
    await this.setMode(tab.id, on);
    if (!on) return;
    if (!this.conns.has(tab.id)) {
      const res = await inject(tab.id);
      if (!res.ok) {
        await this.setMode(tab.id, false);
        await this.tell(tab.id, `Wish can't run on this page (${res.error}). Frames and some sites aren't supported.`);
        return;
      }
    }
    if (!(await chromeStore.get<boolean>(KEYS.triedIt))) await chromeStore.set(KEYS.triedIt, true);
    const origin = originOf(url);
    if (origin) await this.updateSessionMap<{ origin: string }>(SESSION_KEYS.attachedTabs, (m) => (m[tab.id!] = { origin }));
  }

  /** Re-inject after a full navigation on a tab we were attached to (same origin, activeTab still valid). */
  async navigated(tabId: number, url: string): Promise<void> {
    const attached = (await getMap<{ origin: string }>(sessionStore, SESSION_KEYS.attachedTabs))[tabId];
    if (!attached) return;
    if (attached.origin !== originOf(url)) {
      await this.updateSessionMap<unknown>(SESSION_KEYS.attachedTabs, (m) => delete m[tabId]);
      await this.setMode(tabId, false);
      return;
    }
    // Always inject: the old document's port may not have disconnected yet,
    // and the content script ignores a second injection into the same document.
    if (pageSupport(url).ok) await inject(tabId);
  }

  /** Show a reason outside the page (badge title + notification). */
  private async tell(tabId: number, text: string): Promise<void> {
    await chrome.action.setTitle({ tabId, title: `Wish: ${text}` });
    await chrome.action.setBadgeText({ tabId, text: "–" });
    try {
      await chrome.notifications.create(`wi-tell:${tabId}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: "Wish",
        message: text,
        priority: 0,
      });
    } catch {
      // The badge title still explains it.
    }
  }

  private setNotice(tabId: number, notice: Notice | null): void {
    if (notice) this.notices.set(tabId, notice);
    else this.notices.delete(tabId);
    this.schedulePush();
  }

  private async updateSessionMap<T>(key: string, fn: (m: Record<string, T>) => void): Promise<void> {
    const m = await getMap<T>(sessionStore, key);
    fn(m);
    await sessionStore.set(key, m);
  }

  private async updateLocalMap<T>(key: string, fn: (m: Record<string, T>) => void): Promise<void> {
    const m = await getMap<T>(chromeStore, key);
    fn(m);
    await chromeStore.set(key, m);
  }

  // -------------------------------------------------------------------------
  // Messages from tabs

  private async handle(conn: TabConn, msg: ToBg): Promise<void> {
    switch (msg.t) {
      case "hello":
        conn.url = msg.url;
        conn.title = msg.title;
        return;
      case "mode":
        return this.setMode(conn.tabId, msg.on);
      case "exit":
        return this.setMode(conn.tabId, false);
      case "draft.add": {
        const local = await chrome.storage.local.get(KEYS.lastRepo);
        const d = await drafts.loadOrCreate(conn.url, conn.title, defaultRepo(this.repos.list, (local[KEYS.lastRepo] as string) ?? null));
        await drafts.addAnnotation(d, msg.annotation);
        return;
      }
      case "draft.edit":
        return this.withDraft(conn, (d) => drafts.updateComment(d, msg.id, msg.comment));
      case "draft.remove":
        return this.withDraft(conn, (d) => drafts.removeAnnotation(d, msg.id));
      case "draft.setTitle":
        return this.withDraft(conn, (d) => drafts.setTitle(d, msg.title));
      case "draft.setRepo":
        await chromeStore.set(KEYS.lastRepo, msg.repo);
        return this.withDraft(conn, (d) => drafts.setRepo(d, msg.repo));
      case "sendMode": {
        const repo = conn.last?.draft?.repo;
        if (repo) await this.updateLocalMap<SendMode>(KEYS.sendModeByRepo, (m) => (m[repo] = msg.mode));
        return;
      }
      case "send":
        return this.startSend(conn, { t: "issue", mode: msg.mode });
      case "followup":
        return this.startSend(conn, { t: "followup", requestId: msg.requestId });
      case "send.undo": {
        const p = this.pending.get(conn.tabId);
        if (p?.timer) {
          clearTimeout(p.timer);
          this.dropPending(conn.tabId, p);
        }
        return;
      }
      case "integrate":
        return this.integrate(conn, msg.requestId);
      case "preview.open": {
        const r = (await loadRequests(chromeStore))[msg.requestId];
        if (!r) return;
        const url = previewUrlFor(r, pathOf(new URL(msg.path, conn.url).href));
        if (url) await this.openPreview(conn.tabId, url, msg.newTab, r.id);
        return;
      }
      case "preview.exit": {
        const prod = conn.last?.preview?.productionUrl;
        if (prod) await chrome.tabs.update(conn.tabId, { url: prod });
        return;
      }
      case "preview.swap":
        return this.swap(conn.tabId, conn.url);
      case "preview.noticeSeen": {
        const id = conn.last?.preview?.request.id;
        if (msg.forever) await chromeStore.set(KEYS.previewNoticeOff, true);
        if (id) {
          const seen = (await sessionStore.get<string[]>(SESSION_KEYS.previewNoticeSeen)) ?? [];
          if (!seen.includes(id)) await sessionStore.set(SESSION_KEYS.previewNoticeSeen, [...seen, id]);
        }
        return;
      }
      case "request.open": {
        const r = (await loadRequests(chromeStore))[msg.requestId];
        if (!r) return;
        const url = this.bestUrl(r);
        if (msg.newTab) await chrome.tabs.create({ url, openerTabId: conn.tabId });
        else await chrome.tabs.update(conn.tabId, { url });
        return;
      }
      case "request.dismiss": {
        await this.updateLocalMap<string>(KEYS.trackByOrigin, (m) => {
          for (const [origin, id] of Object.entries(m)) if (id === msg.requestId) delete m[origin];
        });
        return;
      }
      case "site.keep":
        return this.keepSite(conn, msg.on);
      case "settings.open":
        await chrome.runtime.openOptionsPage();
        return;
      case "notice.dismiss":
        this.setNotice(conn.tabId, null);
        return;
      case "dock.save": {
        const origin = originOf(conn.url);
        if (origin) await this.updateLocalMap<DockPrefs>(KEYS.dockByOrigin, (m) => (m[origin] = msg.prefs));
        return;
      }
      case "reload":
        await chrome.tabs.reload(conn.tabId);
        return;
    }
  }

  private async withDraft(conn: TabConn, fn: (d: Draft) => Promise<Draft>): Promise<void> {
    const d = await drafts.load(conn.url);
    if (d) await fn(d);
  }

  // -------------------------------------------------------------------------
  // Sending (with undo window)

  private async startSend(conn: TabConn, kind: SendKind): Promise<void> {
    if (this.pending.has(conn.tabId)) return;
    const draft = await drafts.load(conn.url);
    if (!draft || draft.annotations.length === 0) return;
    let label: string;
    if (kind.t === "issue") {
      const repo = conn.last?.draft?.repo ?? draft.repo;
      if (!repo || !draft.title.trim()) {
        this.setNotice(conn.tabId, { text: "Pick a repository and a title first.", tone: "error" });
        return;
      }
      if (repo !== draft.repo) await drafts.setRepo(draft, repo);
      await this.updateLocalMap<SendMode>(KEYS.sendModeByRepo, (m) => (m[repo] = kind.mode));
      label = kind.mode === "file" ? `Filing issue in ${repo}…` : `Filing & building in ${repo}…`;
    } else {
      const r = (await loadRequests(chromeStore))[kind.requestId];
      if (!r || !canFollowUp(r)) {
        this.setNotice(conn.tabId, { text: "This request can't be refined right now.", tone: "error" });
        return;
      }
      label = r.prNumber ? `Sending to PR #${r.prNumber}…` : "Sending follow-up…";
    }
    this.notices.delete(conn.tabId);
    const p: PendingSend = { kind, label, undoUntil: Date.now() + UNDO_MS, draftUrl: draft.tabUrl, timer: undefined };
    this.schedule(conn.tabId, p);
    await this.updateSessionMap<StoredSend>(SESSION_KEYS.pendingSends, (m) => (m[conn.tabId] = stored(p)));
  }

  private schedule(tabId: number, p: PendingSend): void {
    this.pending.set(tabId, p);
    p.timer = setTimeout(
      () => {
        p.timer = undefined;
        p.undoUntil = 0;
        this.schedulePush();
        this.enqueue(() => this.commit(tabId, p));
      },
      Math.max(0, p.undoUntil - Date.now()),
    );
  }

  private dropPending(tabId: number, p: PendingSend): void {
    if (this.pending.get(tabId) !== p) return;
    this.pending.delete(tabId);
    void this.updateSessionMap<StoredSend>(SESSION_KEYS.pendingSends, (m) => delete m[tabId]);
  }

  private async commit(tabId: number, p: PendingSend): Promise<void> {
    try {
      if (this.pending.get(tabId) !== p) return;
      const session = await getSession();
      if (!session) throw new ApiError(401, "unauthorized", "Signed out.");
      const draft = await drafts.load(p.draftUrl);
      if (!draft || draft.annotations.length === 0) return;
      let view: RequestView;
      if (p.kind.t === "issue") {
        if (!draft.repo) throw new Error("Pick a repository first.");
        view = await api.createIssue(session, {
          clientRequestId: draft.clientRequestId,
          repo: draft.repo,
          title: draft.title.trim(),
          pageUrl: draft.tabUrl,
          pageTitle: draft.pageTitle,
          annotations: draft.annotations,
          dryRun: p.kind.mode === "file",
        });
        const origin = originOf(draft.tabUrl);
        if (origin) await this.updateLocalMap<string>(KEYS.trackByOrigin, (m) => (m[origin] = view.id));
      } else {
        view = await api.followup(session, p.kind.requestId, {
          clientFollowupId: draft.clientRequestId,
          pageUrl: draft.tabUrl,
          pageTitle: draft.pageTitle,
          annotations: draft.annotations,
        });
      }
      await saveRequest(chromeStore, view);
      await drafts.clear(draft.tabUrl);
      await this.setMode(tabId, false);
    } catch (err) {
      if (err instanceof ApiError && err.unauthorized) {
        await this.unauthorized();
        this.setNotice(tabId, { text: "Signed out. Connect GitHub again; your comments are kept.", tone: "error" });
      } else {
        const text = err instanceof ApiError && err.code === "in_progress" ? "Still sending. Try again in a moment." : errorText(err);
        this.setNotice(tabId, { text: `${text} Your comments are kept.`, tone: "error" });
      }
    } finally {
      this.dropPending(tabId, p);
      this.schedulePush();
    }
  }

  // -------------------------------------------------------------------------
  // Integrate, previews, sites

  private async integrate(conn: TabConn, requestId: string): Promise<void> {
    const session = await getSession();
    if (!session) return this.unauthorized();
    try {
      await this.recordView(await api.integrate(session, requestId));
    } catch (err) {
      if (err instanceof ApiError && err.unauthorized) return this.unauthorized();
      this.setNotice(conn.tabId, { text: errorText(err), tone: "error" });
    }
  }

  private async swap(tabId: number, url: string): Promise<void> {
    const requests = Object.values(await loadRequests(chromeStore));
    const preview = previewRequestFor(url, requests);
    if (preview) {
      const prod = productionUrlFor(preview, pathOf(url));
      if (prod) await chrome.tabs.update(tabId, { url: prod });
      return;
    }
    const origin = originOf(url);
    const tracked = origin ? (await getMap<string>(chromeStore, KEYS.trackByOrigin))[origin] : undefined;
    const fromTab = (await getMap<string>(sessionStore, SESSION_KEYS.tabPreview))[tabId];
    const r = requests.find((x) => x.id === tracked && x.previewUrl) ?? requests.find((x) => x.id === fromTab && x.previewUrl);
    if (!r) {
      this.setNotice(tabId, { text: "No preview for this site yet.", tone: "info" });
      return;
    }
    const target = previewUrlFor(r, pathOf(url));
    if (target) await this.openPreview(tabId, target, false, r.id);
  }

  /** Command ⌥⇧P (no content script needed). */
  async swapActive(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.id !== undefined && tab.url) await this.swap(tab.id, tab.url);
  }

  private async openPreview(tabId: number, url: string, newTab: boolean, requestId: string): Promise<void> {
    if (matchesPattern(url, PREVIEW_PATTERN) && !(await hasOrigins([PREVIEW_PATTERN]))) {
      await this.openGrant(PREVIEW_PATTERN, { kind: "preview", tabId, url, newTab, requestId });
      return;
    }
    await this.navigatePreview(tabId, url, newTab, requestId);
  }

  private async navigatePreview(tabId: number, url: string, newTab: boolean, requestId: string): Promise<void> {
    let target = tabId;
    if (newTab) {
      const tab = await chrome.tabs.get(tabId);
      const created = await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tabId });
      if (created.id === undefined) return;
      target = created.id;
    } else {
      await chrome.tabs.update(tabId, { url });
    }
    await this.updateSessionMap<string>(SESSION_KEYS.tabPreview, (m) => (m[target] = requestId));
  }

  private async keepSite(conn: TabConn, on: boolean): Promise<void> {
    const origin = originOf(conn.url);
    if (!origin) return;
    if (!on) {
      const kept = ((await chromeStore.get<string[]>(KEYS.keptSites)) ?? []).filter((o) => o !== origin);
      await chromeStore.set(KEYS.keptSites, kept);
      await reconcileRegistrations(kept);
      // Drop the site permission unless it's also covered by the preview pattern.
      if (!matchesPattern(origin + "/", PREVIEW_PATTERN)) {
        await chrome.permissions.remove({ origins: [originPattern(origin)] }).catch(() => false);
      }
      this.setNotice(conn.tabId, { text: `Wish no longer starts on ${new URL(origin).host}.`, tone: "info" });
      return;
    }
    if (await hasOrigins([originPattern(origin)])) {
      await this.finishKeep(conn.tabId, origin);
      return;
    }
    await this.openGrant(originPattern(origin), { kind: "keep", tabId: conn.tabId, origin });
  }

  private async finishKeep(tabId: number, origin: string): Promise<void> {
    const kept = (await chromeStore.get<string[]>(KEYS.keptSites)) ?? [];
    if (!kept.includes(origin)) kept.push(origin);
    await chromeStore.set(KEYS.keptSites, kept);
    await reconcileRegistrations(kept);
    this.setNotice(tabId, { text: `Wish stays on for ${new URL(origin).host}.`, tone: "info" });
  }

  /**
   * Content scripts can't call permissions.request, so a small extension
   * window asks for it (UX-PLAN §5.5).
   */
  private async openGrant(pattern: string, then: GrantThen): Promise<void> {
    const q = new URLSearchParams({ grant: pattern, reason: then.kind });
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`settings/index.html#${q}`),
      type: "popup",
      width: 420,
      height: 300,
      focused: true,
    });
    if (win?.id === undefined) return;
    const g: PendingGrant = { windowId: win.id, then };
    this.grants.set(win.id, g);
    await this.updateSessionMap<PendingGrant>(SESSION_KEYS.pendingGrants, (m) => (m[g.windowId] = g));
  }

  /** Result from the grant window (or the window was closed: declined). */
  async grantResult(windowId: number, granted: boolean): Promise<void> {
    await this.ready;
    const g = this.grants.get(windowId);
    if (!g) return;
    this.grants.delete(windowId);
    await this.updateSessionMap<PendingGrant>(SESSION_KEYS.pendingGrants, (m) => delete m[windowId]);
    const then = g.then;
    if (then.kind === "keep") {
      if (granted) await this.finishKeep(then.tabId, then.origin);
      else this.setNotice(then.tabId, { text: "Not kept on: access to this site wasn't granted.", tone: "info" });
      return;
    }
    if (granted) {
      await reconcileRegistrations((await chromeStore.get<string[]>(KEYS.keptSites)) ?? []);
    } else {
      this.setNotice(then.tabId, { text: "Opening the preview without the banner (no access to preview sites).", tone: "info" });
      await new Promise((r) => setTimeout(r, 1500));
    }
    await this.navigatePreview(then.tabId, then.url, then.newTab, then.requestId).catch(() => undefined);
  }

  windowClosed(windowId: number): void {
    void this.ready.then(() => {
      if (this.grants.has(windowId)) return this.grantResult(windowId, false);
    });
  }
}

function stored(p: PendingSend): StoredSend {
  return { kind: p.kind, label: p.label, undoUntil: p.undoUntil, draftUrl: p.draftUrl };
}
