import { isTerminalState, type Annotation, type RepoInfo, type RequestView } from "@web-issuer/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ContentMessage, PanelMessage, PinSpec } from "../messages";
import { chromeStore, KEYS } from "../storage";
import { loadRequests, saveRequest, summarize, type RequestMap } from "../tracking";
import { api, ApiError, connectGitHub, liveUrl } from "./api";
import { DraftStore, pageKey, type Draft } from "./draft-store";

const drafts = new DraftStore(chromeStore);

interface TabInfo {
  id: number;
  url: string;
  title: string;
}

type Support = { ok: true } | { ok: false; reason: string };

export function pageSupport(url: string): Support {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "This page can't be annotated." };
  }
  if (u.protocol === "file:") return { ok: false, reason: "Local files aren't supported. Open the page from a web server." };
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "Browser pages can't be annotated. Open a website to add feedback." };
  }
  if (u.hostname === "chromewebstore.google.com" || (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"))) {
    return { ok: false, reason: "Chrome doesn't allow extensions on the Web Store." };
  }
  if (/\.pdf$/i.test(u.pathname)) return { ok: false, reason: "PDFs can't be annotated." };
  return { ok: true };
}

async function currentTab(): Promise<TabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return null;
  return { id: tab.id, url: tab.url, title: tab.title ?? "" };
}

async function sendToTab(tabId: number, message: PanelMessage): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return undefined;
  }
}

async function isInjected(tabId: number): Promise<boolean> {
  return !!(await sendToTab(tabId, { type: "wi:ping" }));
}

/** Must be called from a user gesture (permission prompt). */
async function ensureInjected(tab: TabInfo): Promise<boolean> {
  const origin = `${new URL(tab.url).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) return false;
  if (!(await isInjected(tab.id))) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
  return true;
}

function pinsFor(annotations: Annotation[]): PinSpec[] {
  return annotations.map((a, i) => ({ number: i + 1, locator: a.locator, rect: a.rect, scroll: a.scroll }));
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------

export function App() {
  const [session, setSession] = useState<string | null | undefined>(undefined);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [requests, setRequests] = useState<RequestMap>({});
  const [trackByPage, setTrackByPage] = useState<Record<string, string>>({});

  useEffect(() => {
    void chromeStore.get<string>(KEYS.session).then((s) => setSession(s ?? null));
    void loadRequests(chromeStore).then(setRequests);
    void chromeStore.get<Record<string, string>>(KEYS.trackByPage).then((t) => setTrackByPage(t ?? {}));
    void chrome.action.setBadgeText({ text: "" });

    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      if (changes[KEYS.requests]) setRequests((changes[KEYS.requests]!.newValue as RequestMap) ?? {});
      if (changes[KEYS.trackByPage]) setTrackByPage((changes[KEYS.trackByPage]!.newValue as Record<string, string>) ?? {});
      if (changes[KEYS.session]) setSession((changes[KEYS.session]!.newValue as string) ?? null);
    };
    chrome.storage.onChanged.addListener(onChanged);

    const refreshTab = () => void currentTab().then(setTab);
    refreshTab();
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (info.url || info.status === "complete" || info.title) refreshTab();
    };
    chrome.tabs.onActivated.addListener(refreshTab);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(refreshTab);
    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      chrome.tabs.onActivated.removeListener(refreshTab);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(refreshTab);
    };
  }, []);

  const signOut = useCallback(async () => {
    const s = await chromeStore.get<string>(KEYS.session);
    await chromeStore.remove(KEYS.session);
    setSession(null);
    if (s) await api.logout(s).catch(() => undefined);
  }, []);

  if (session === undefined) return <main class="panel" aria-busy="true" />;
  if (session === null) return <Connect onConnected={setSession} />;

  const key = tab ? pageKey(tab.url) : null;
  const trackedId = key ? trackByPage[key] : undefined;
  const tracked = trackedId ? requests[trackedId] : undefined;

  return (
    <main class="panel">
      {tracked && tab ? (
        <Track
          session={session}
          request={tracked}
          onUnauthorized={signOut}
          onDone={async () => {
            const next = { ...trackByPage };
            delete next[pageKey(tab.url)];
            await chromeStore.set(KEYS.trackByPage, next);
          }}
        />
      ) : (
        <Feedback session={session} tab={tab} onUnauthorized={signOut} />
      )}
      <footer class="foot">
        <button type="button" class="link" onClick={signOut}>
          Sign out
        </button>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Connect({ onConnected }: { onConnected(session: string): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await connectGitHub();
      await chromeStore.set(KEYS.session, session);
      onConnected(session);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="panel center">
      <h1 class="title">web-issuer</h1>
      <p class="muted">Point at what should change on a page and turn it into one GitHub issue.</p>
      <button type="button" class="primary" onClick={connect} disabled={busy}>
        {busy ? "Connecting…" : "Connect GitHub"}
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function useRepos(session: string, onUnauthorized: () => void) {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api
      .repos(session)
      .then((r) => setRepos(r.repos))
      .catch((err) => {
        if (err instanceof ApiError && err.unauthorized) onUnauthorized();
        else setError(errorText(err));
      });
  }, [session, onUnauthorized]);
  useEffect(load, [load]);
  return { repos, error, reload: load };
}

function Feedback({ session, tab, onUnauthorized }: { session: string; tab: TabInfo | null; onUnauthorized(): void }) {
  const { repos, error: reposError, reload } = useRepos(session, onUnauthorized);
  const [lastRepo, setLastRepo] = useState<string | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const queue = useRef(Promise.resolve());
  const [mode, setMode] = useState<"annotate" | "review">("annotate");
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setDraft = (d: Draft | null) => {
    draftRef.current = d;
    setDraftState(d);
  };

  /** Serialise draft updates (annotations can arrive quickly). */
  const update = useCallback((fn: (d: Draft) => Promise<Draft>) => {
    queue.current = queue.current.then(async () => {
      if (!draftRef.current) return;
      setDraft(await fn(draftRef.current));
    });
    return queue.current;
  }, []);

  useEffect(() => {
    void chromeStore.get<string>(KEYS.lastRepo).then((r) => setLastRepo(r ?? null));
  }, []);

  const support = tab ? pageSupport(tab.url) : null;
  const tabKey = tab ? pageKey(tab.url) : null;

  // Load (or start) the draft for the current page.
  useEffect(() => {
    setMode("annotate");
    setPicking(false);
    setNotice(null);
    if (!tab || !support?.ok) {
      setDraft(null);
      return;
    }
    let cancelled = false;
    void drafts.loadOrCreate(tab.url, tab.title, lastRepo).then(async (d) => {
      if (cancelled) return;
      setDraft(d);
      if (await isInjected(tab.id)) {
        await sendToTab(tab.id, { type: "wi:pins", pins: pinsFor(d.annotations) });
        const state = (await sendToTab(tab.id, { type: "wi:ping" })) as { active?: boolean } | undefined;
        setPicking(!!state?.active);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey, tab?.id]);

  // Pick a default repo once the list is known.
  useEffect(() => {
    const d = draftRef.current;
    if (!d || !repos || repos.length === 0) return;
    if (d.repo && repos.some((r) => r.fullName === d.repo)) return;
    const preferred = repos.find((r) => r.fullName === lastRepo) ?? repos.find((r) => r.tracked) ?? repos[0]!;
    setDraft({ ...d, repo: preferred.fullName });
  }, [repos, draft?.clientRequestId, lastRepo]);

  // Keep the pins in sync with the draft.
  useEffect(() => {
    if (tab && draft) void sendToTab(tab.id, { type: "wi:pins", pins: pinsFor(draft.annotations) });
  }, [draft?.annotations, tab?.id]);

  // Messages from the content script.
  useEffect(() => {
    if (!tab) return;
    const listener = (message: ContentMessage, sender: chrome.runtime.MessageSender) => {
      if (sender.tab?.id !== tab.id) return;
      if (message.type === "wi:picker-state") setPicking(message.active);
      if (message.type === "wi:annotation") {
        if (pageKey(message.pageUrl) !== pageKey(tab.url)) return;
        void update((d) => drafts.addAnnotation(d, message.annotation));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tab?.id, tabKey, update]);

  if (!tab) return <p class="muted">No active tab.</p>;

  const header = (
    <header class="page">
      <div class="page-title" title={tab.title}>
        {tab.title || domainOf(tab.url)}
      </div>
      <div class="muted small">{domainOf(tab.url)}</div>
    </header>
  );

  if (!support?.ok) {
    return (
      <>
        {header}
        <p class="muted">{support?.reason}</p>
      </>
    );
  }
  if (!draft) return header;

  const startPicking = async () => {
    setNotice(null);
    try {
      if (!(await ensureInjected(tab))) {
        setNotice("web-issuer needs access to this site to add feedback.");
        return;
      }
      await sendToTab(tab.id, { type: "wi:pins", pins: pinsFor(draft.annotations) });
      await sendToTab(tab.id, { type: "wi:start" });
      setPicking(true);
    } catch (err) {
      setNotice(`Can't add feedback on this page (${errorText(err)}). Frames and some sites aren't supported.`);
    }
  };

  const stopPicking = async () => {
    await sendToTab(tab.id, { type: "wi:stop" });
    setPicking(false);
  };

  const highlight = async (a: Annotation, index: number) => {
    try {
      if (!(await ensureInjected(tab))) return;
      await sendToTab(tab.id, { type: "wi:pins", pins: pinsFor(draft.annotations) });
      const res = (await sendToTab(tab.id, {
        type: "wi:highlight",
        pin: { number: index + 1, locator: a.locator, rect: a.rect, scroll: a.scroll },
      })) as
        | { found?: boolean }
        | undefined;
      setNotice(res && res.found === false ? `Comment ${index + 1}: element not found on the page anymore.` : null);
    } catch {
      // Highlighting is best effort.
    }
  };

  const chooseRepo = async (repo: string) => {
    setLastRepo(repo);
    await chromeStore.set(KEYS.lastRepo, repo);
    await update((d) => drafts.setRepo(d, repo));
  };

  if (mode === "review") {
    return (
      <>
        {header}
        <Review
          session={session}
          tab={tab}
          draft={draft}
          repos={repos}
          onTitle={(t) => update((d) => drafts.setTitle(d, t))}
          onBack={() => setMode("annotate")}
          onUnauthorized={onUnauthorized}
        />
      </>
    );
  }

  const count = draft.annotations.length;
  return (
    <>
      {header}
      <RepoPicker repos={repos} error={reposError} value={draft.repo} onChange={chooseRepo} onRetry={reload} />
      {picking ? (
        <div class="picking">
          <p class="small">Click an element on the page to comment. Press Esc to finish.</p>
          <button type="button" onClick={stopPicking}>
            Done selecting
          </button>
        </div>
      ) : (
        <button type="button" class={count === 0 ? "primary" : ""} onClick={startPicking}>
          Add feedback
        </button>
      )}
      {notice && <p class="notice">{notice}</p>}
      {count > 0 && (
        <AnnotationList
          annotations={draft.annotations}
          onHighlight={highlight}
          onEdit={(id, comment) => update((d) => drafts.updateComment(d, id, comment))}
          onDelete={(id) => update((d) => drafts.removeAnnotation(d, id))}
        />
      )}
      {count > 0 && (
        <button
          type="button"
          class="primary"
          disabled={!draft.repo}
          onClick={async () => {
            if (picking) await stopPicking();
            setMode("review");
          }}
        >
          Review ({count})
        </button>
      )}
      {count === 0 && <p class="muted small">Only the top frame of the page can be annotated.</p>}
    </>
  );
}

function RepoPicker(props: {
  repos: RepoInfo[] | null;
  error: string | null;
  value: string | null;
  onChange(repo: string): void;
  onRetry(): void;
}) {
  if (props.error) {
    return (
      <p class="error" role="alert">
        Couldn't load repositories: {props.error}{" "}
        <button type="button" class="link" onClick={props.onRetry}>
          Retry
        </button>
      </p>
    );
  }
  if (!props.repos) return <p class="muted small">Loading repositories…</p>;
  if (props.repos.length === 0) {
    return <p class="notice">No repositories yet. Install the GitHub App on a repository, then reopen this panel.</p>;
  }
  return (
    <label class="field">
      <span class="label">Repository</span>
      <select value={props.value ?? ""} onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}>
        {props.repos.map((r) => (
          <option key={r.fullName} value={r.fullName}>
            {r.fullName}
          </option>
        ))}
      </select>
    </label>
  );
}

function AnnotationList(props: {
  annotations: Annotation[];
  onHighlight(a: Annotation, index: number): void;
  onEdit(id: string, comment: string): void;
  onDelete(id: string): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  return (
    <ol class="comments">
      {props.annotations.map((a, i) => (
        <li key={a.id} class="comment">
          <span class="num" aria-hidden="true">
            {i + 1}
          </span>
          {editing === a.id ? (
            <form
              class="edit"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) props.onEdit(a.id, text.trim());
                setEditing(null);
              }}
            >
              <textarea
                value={text}
                aria-label={`Edit comment ${i + 1}`}
                onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(null);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
                }}
                ref={(el) => el?.focus()}
              />
              <div class="row">
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="submit" class="primary" disabled={!text.trim()}>
                  Save
                </button>
              </div>
            </form>
          ) : (
            <>
              <button type="button" class="comment-body" onClick={() => props.onHighlight(a, i)} title="Show on page">
                <span class="comment-text">{a.comment}</span>
                <span class="muted small target">
                  {a.kind}
                  {a.text ? ` “${a.text}”` : ""}
                </span>
              </button>
              <div class="actions">
                <button
                  type="button"
                  class="link"
                  onClick={() => {
                    setText(a.comment);
                    setEditing(a.id);
                  }}
                  aria-label={`Edit comment ${i + 1}`}
                >
                  Edit
                </button>
                <button type="button" class="link" onClick={() => props.onDelete(a.id)} aria-label={`Delete comment ${i + 1}`}>
                  Delete
                </button>
              </div>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------

function Review(props: {
  session: string;
  tab: TabInfo;
  draft: Draft;
  repos: RepoInfo[] | null;
  onTitle(title: string): void;
  onBack(): void;
  onUnauthorized(): void;
}) {
  const { draft } = props;
  const [dryRun, setDryRun] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    void chromeStore.get<boolean>(KEYS.dryRun).then((v) => setDryRun(v ?? true));
  }, []);

  const repo = props.repos?.find((r) => r.fullName === draft.repo);
  const title = draft.title.trim();

  const submit = async () => {
    if (inFlight.current || !draft.repo || !title) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const view = await api.createIssue(props.session, {
        clientRequestId: draft.clientRequestId,
        repo: draft.repo,
        title,
        pageUrl: draft.tabUrl,
        pageTitle: draft.pageTitle,
        annotations: draft.annotations,
        dryRun,
      });
      await saveRequest(chromeStore, view);
      const track = (await chromeStore.get<Record<string, string>>(KEYS.trackByPage)) ?? {};
      track[pageKey(draft.tabUrl)] = view.id;
      await chromeStore.set(KEYS.trackByPage, track);
      await drafts.clear(draft.tabUrl);
      await sendToTab(props.tab.id, { type: "wi:pins", pins: [] });
      await sendToTab(props.tab.id, { type: "wi:stop" });
    } catch (err) {
      if (err instanceof ApiError && err.unauthorized) {
        props.onUnauthorized();
        return;
      }
      setError(err instanceof ApiError && err.code === "in_progress" ? "Still creating the issue. Try again in a moment." : errorText(err));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form
      class="review"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label class="field">
        <span class="label">Issue title</span>
        <input
          type="text"
          value={draft.title}
          maxLength={256}
          onInput={(e) => props.onTitle((e.target as HTMLInputElement).value)}
          required
        />
      </label>
      <ol class="comments compact">
        {draft.annotations.map((a, i) => (
          <li key={a.id} class="comment">
            <span class="num" aria-hidden="true">
              {i + 1}
            </span>
            <span class="comment-text">{a.comment}</span>
          </li>
        ))}
      </ol>
      <p class="small">
        To <strong>{draft.repo}</strong>
        {repo && !repo.tracked ? <span class="muted"> · progress isn't tracked for this repository</span> : null}
      </p>
      <label class="toggle">
        <input
          type="checkbox"
          checked={dryRun}
          onChange={(e) => {
            const v = (e.target as HTMLInputElement).checked;
            setDryRun(v);
            void chromeStore.set(KEYS.dryRun, v);
          }}
        />
        <span>Dry run (create the issue without starting automation)</span>
      </label>
      <p class="muted small">Issues on public repos are visible to everyone.</p>
      {error && (
        <p class="error" role="alert">
          {error} Your draft is kept.
        </p>
      )}
      <button type="submit" class="primary" disabled={submitting || !title || !draft.repo}>
        {submitting ? "Creating issue…" : "Create issue"}
      </button>
      <button type="button" class="link" onClick={props.onBack} disabled={submitting}>
        Back to comments
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

const POLL_MS = 10_000;

function useLiveRequest(session: string, request: RequestView, onUnauthorized: () => void) {
  const done = isTerminalState(request.state);
  useEffect(() => {
    if (done) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let reconnectTimer: number | undefined;

    const store = (view: RequestView) => void saveRequest(chromeStore, view);

    const poll = async () => {
      if (socket?.readyState === WebSocket.OPEN) return;
      try {
        store(await api.request(session, request.id));
      } catch (err) {
        if (err instanceof ApiError && err.unauthorized) onUnauthorized();
      }
    };

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(liveUrl(session, request.id));
      socket.onopen = () => {
        retry = 0;
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data === "pong") return;
        try {
          const msg = JSON.parse(event.data) as { type: string; request: RequestView };
          if (msg.type === "state") store(msg.request);
        } catch {
          // Ignore malformed messages.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        reconnectTimer = window.setTimeout(connect, 1000 * 2 ** retry);
      };
    };

    connect();
    void poll();
    const pollTimer = window.setInterval(() => void poll(), POLL_MS);
    const pingTimer = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    }, 30_000);
    return () => {
      closed = true;
      window.clearInterval(pollTimer);
      window.clearInterval(pingTimer);
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [session, request.id, done, onUnauthorized]);
}

function Track(props: { session: string; request: RequestView; onDone(): void; onUnauthorized(): void }) {
  const r = props.request;
  useLiveRequest(props.session, r, props.onUnauthorized);
  const summary = useMemo(() => summarize(r), [r]);
  const finished = isTerminalState(r.state);

  const primaryPreview = (r.state === "succeeded" || r.state === "checks_failed") && r.previewUrl;
  return (
    <section class="track" aria-live="polite">
      <h1 class="title">{r.title}</h1>
      {r.issueUrl && (
        <a class="small" href={r.issueUrl} target="_blank" rel="noreferrer">
          Issue #{r.issueNumber} ↗
        </a>
      )}
      <ul class="steps">
        {summary.steps.map((s) => (
          <li key={s.label} class="step done">
            <span aria-hidden="true">✓</span> {s.label}
          </li>
        ))}
        {summary.headline && <li class={`step current ${summary.tone}`}>{summary.headline}</li>}
      </ul>
      {r.message && r.state !== "succeeded" && <p class="small">{r.message}</p>}
      {r.state === "succeeded" && r.message && <p class="muted small">{r.message}</p>}
      <div class="links">
        {primaryPreview && (
          <a class="button primary" href={r.previewUrl!} target="_blank" rel="noreferrer">
            Open preview
          </a>
        )}
        {r.prUrl && (
          <a class="button" href={r.prUrl} target="_blank" rel="noreferrer">
            View PR
          </a>
        )}
        {r.runUrl ? (
          <a class="small" href={r.runUrl} target="_blank" rel="noreferrer">
            View workflow ↗
          </a>
        ) : (
          r.stalled && (
            <a class="small" href={r.actionsUrl} target="_blank" rel="noreferrer">
              Open the Actions tab ↗
            </a>
          )
        )}
      </div>
      <button type="button" class={finished && !primaryPreview ? "primary" : ""} onClick={props.onDone}>
        {finished ? "New feedback" : "Hide (keeps tracking)"}
      </button>
    </section>
  );
}
