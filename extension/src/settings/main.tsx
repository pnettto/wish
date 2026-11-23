import type { RepoInfo, RequestView } from "@web-issuer/shared";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  api,
  ApiError,
  connectGitHub,
  errorText,
  signOut,
} from "../background/api";
import { PREVIEW_PATTERN } from "../config";
import { originPattern, type SendMode } from "../page";
import { chromeStore, KEYS } from "../storage";
import { loadRequests, summarize } from "../tracking";
import {
  onboardingComplete,
  onboardingSteps,
  pickTryTab,
  type Step,
  type StepId,
} from "./onboarding";
import "./styles.css";

/**
 * Options page: sign-in, permissions, preferences and history. Also the small
 * "grant" window the background opens when the page needs a host permission
 * (content scripts can't call permissions.request).
 */

const notifyBackground = () =>
  void chrome.runtime
    .sendMessage({ t: "settings.changed" })
    .catch(() => undefined);

function Grant({ pattern, reason }: { pattern: string; reason: string }) {
  const [busy, setBusy] = useState(false);
  const host = pattern.replace(/^\w+:\/\//, "").replace(/\/\*$/, "");
  const done = async (granted: boolean) => {
    const win = await chrome.windows.getCurrent();
    await chrome.runtime
      .sendMessage({ t: "grant.done", granted, windowId: win.id })
      .catch(() => undefined);
    window.close();
  };
  return (
    <main class="page grant">
      <h1>
        {reason === "preview" ? "Allow preview sites" : "Keep web-issuer on"}
      </h1>
      <p class="muted">
        {reason === "preview"
          ? `web-issuer needs access to ${host} to show the preview banner and let you refine and merge from the preview.`
          : `web-issuer needs access to ${host} to start automatically there after reloads and navigation.`}
      </p>
      <div class="row">
        <button
          type="button"
          class="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const granted = await chrome.permissions
              .request({ origins: [pattern] })
              .catch(() => false);
            await done(granted);
          }}
        >
          Allow
        </button>
        <button type="button" onClick={() => done(false)} disabled={busy}>
          Not now
        </button>
      </div>
    </main>
  );
}

const STEP_TEXT: Record<StepId, { title: string; body: string }> = {
  connect: {
    title: "Connect GitHub",
    body: "Sign in so web-issuer can file issues in your repositories.",
  },
  previews: {
    title: "Allow preview sites",
    body: "Lets web-issuer show the preview banner and let you refine and merge from previews. You can do this later.",
  },
  try: {
    title: "Try it on a page",
    body: "On any website, click the web-issuer toolbar icon or press ⌥⇧F, then click something to comment on it.",
  },
};

async function openTryTab() {
  const tab = pickTryTab(await chrome.tabs.query({ windowType: "normal" }));
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: "https://example.com/" });
  }
}

function Onboarding(props: {
  steps: Step[];
  busy: boolean;
  onConnect(): void;
  onAllowPreviews(): void;
  onSkipPreviews(): void;
}) {
  const actions: Record<StepId, preact.ComponentChild> = {
    connect: (
      <button
        type="button"
        class="primary"
        onClick={props.onConnect}
        disabled={props.busy}
      >
        {props.busy ? "Connecting…" : "Connect GitHub"}
      </button>
    ),
    previews: (
      <>
        <button type="button" class="primary" onClick={props.onAllowPreviews}>
          Allow preview sites
        </button>
        <button type="button" class="link" onClick={props.onSkipPreviews}>
          Skip
        </button>
      </>
    ),
    try: (
      <button type="button" class="primary" onClick={() => void openTryTab()}>
        Take me to a page
      </button>
    ),
  };
  return (
    <section class="onboarding" aria-labelledby="h-start">
      <h2 id="h-start">Get started</h2>
      <ol class="steps">
        {props.steps.map((step, i) => (
          <li
            key={step.id}
            class={`step ${step.status}`}
            aria-current={step.status === "current" ? "step" : undefined}
          >
            <span class="step-mark" aria-hidden="true">
              {step.status === "done"
                ? "✓"
                : step.status === "skipped"
                  ? "–"
                  : i + 1}
            </span>
            <div class="grow">
              <strong>{STEP_TEXT[step.id].title}</strong>
              {step.status === "skipped" && (
                <span class="muted small"> · skipped</span>
              )}
              {step.status === "current" && (
                <>
                  <p class="muted small">{STEP_TEXT[step.id].body}</p>
                  <div class="row">{actions[step.id]}</div>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function useStored<T>(key: string, fallback: T): [T, (v: T) => Promise<void>] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    void chromeStore.get<T>(key).then((v) => setValue(v ?? fallback));
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes[key])
        setValue((changes[key]!.newValue as T) ?? fallback);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [value, (v: T) => chromeStore.set(key, v)];
}

function Settings() {
  const [session] = useStored<string | null>(KEYS.session, null);
  const [lastRepo, setLastRepo] = useStored<string | null>(KEYS.lastRepo, null);
  const [modes, setModes] = useStored<Record<string, SendMode>>(
    KEYS.sendModeByRepo,
    {},
  );
  const [kept, setKept] = useStored<string[]>(KEYS.keptSites, []);
  const [, setNoticeOff] = useStored<boolean>(KEYS.previewNoticeOff, false);
  const [previewSkipped, setPreviewSkipped] = useStored<boolean>(
    KEYS.previewSkipped,
    false,
  );
  const [triedIt] = useStored<boolean>(KEYS.triedIt, false);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<boolean | null>(null);
  const [recent, setRecent] = useState<RequestView[]>([]);

  useEffect(() => {
    const check = () =>
      void chrome.permissions
        .contains({ origins: [PREVIEW_PATTERN] })
        .then(setPreviews);
    check();
    chrome.permissions.onAdded.addListener(check);
    chrome.permissions.onRemoved.addListener(check);
    const loadRecent = () =>
      void loadRequests(chromeStore).then((m) =>
        setRecent(
          Object.values(m)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 20),
        ),
      );
    loadRecent();
    const onChanged = (
      c: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && c[KEYS.requests]) loadRecent();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      chrome.permissions.onAdded.removeListener(check);
      chrome.permissions.onRemoved.removeListener(check);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  useEffect(() => {
    setRepos(null);
    if (!session) return;
    api
      .repos(session)
      .then((r) => {
        setRepos(r.repos);
        setLogin(r.login);
      })
      .catch(async (err) => {
        if (err instanceof ApiError && err.unauthorized)
          await chromeStore.remove(KEYS.session);
        else setError(errorText(err));
      });
  }, [session]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await chromeStore.set(KEYS.session, await connectGitHub());
      notifyBackground();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const allowPreviews = async () => {
    if (await chrome.permissions.request({ origins: [PREVIEW_PATTERN] }))
      notifyBackground();
  };
  const steps = onboardingSteps({
    signedIn: !!session,
    previews,
    previewSkipped,
    triedIt,
  });
  // Wait for the permission check so the checklist doesn't flash for set-up users.
  const showOnboarding = previews !== null && !onboardingComplete(steps);

  return (
    <main class="page">
      <header>
        <h1>web-issuer</h1>
        <p class="muted">
          Point at what should change on a page and turn it into one GitHub
          issue.
        </p>
      </header>

      {showOnboarding && (
        <Onboarding
          steps={steps}
          busy={busy}
          onConnect={connect}
          onAllowPreviews={allowPreviews}
          onSkipPreviews={() => void setPreviewSkipped(true)}
        />
      )}
      {showOnboarding && error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {!(showOnboarding && !session) && (
        <section aria-labelledby="h-account">
          <h2 id="h-account">GitHub</h2>
          {session ? (
            <div class="row">
              <span class="grow">Connected{login ? ` as ${login}` : ""}.</span>
              <button
                type="button"
                onClick={async () => {
                  await signOut();
                  notifyBackground();
                }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div class="row">
              <button
                type="button"
                class="primary"
                onClick={connect}
                disabled={busy}
              >
                {busy ? "Connecting…" : "Connect GitHub"}
              </button>
            </div>
          )}
          {error && !showOnboarding && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="h-use">
        <h2 id="h-use">Using it</h2>
        <p>
          Click the toolbar icon or press <kbd>⌥⇧F</kbd> on any page to start
          commenting. <kbd>⌥⇧P</kbd> swaps between a preview and the live site.
        </p>
        <p class="muted small">
          Change shortcuts at <code>chrome://extensions/shortcuts</code>.
        </p>
      </section>

      <section aria-labelledby="h-previews">
        <h2 id="h-previews">Preview sites</h2>
        <p class="muted small">
          Access to <code>{PREVIEW_PATTERN}</code> lets web-issuer show the
          preview banner, refine and merge from the preview.
        </p>
        {previews ? (
          <div class="row">
            <span class="ok grow">Allowed.</span>
            <button
              type="button"
              onClick={async () => {
                await chrome.permissions.remove({ origins: [PREVIEW_PATTERN] });
                notifyBackground();
              }}
            >
              Remove access
            </button>
          </div>
        ) : (
          <div class="row">
            <button type="button" class="primary" onClick={allowPreviews}>
              Allow preview sites
            </button>
          </div>
        )}
        <button type="button" class="link" onClick={() => setNoticeOff(false)}>
          Show the preview notice again
        </button>
      </section>

      {session && (
        <section aria-labelledby="h-repos">
          <h2 id="h-repos">Repositories</h2>
          {!repos ? (
            <p class="muted">Loading…</p>
          ) : repos.length === 0 ? (
            <p>No repositories yet. Install the GitHub App on a repository.</p>
          ) : (
            <>
              <label class="field">
                <span class="label">Default repository</span>
                <select
                  value={lastRepo ?? ""}
                  onChange={(e) =>
                    setLastRepo((e.target as HTMLSelectElement).value)
                  }
                >
                  {!lastRepo && (
                    <option value="">(first tracked repository)</option>
                  )}
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <ul class="list" aria-label="Default action per repository">
                {repos.map((r) => (
                  <li key={r.fullName}>
                    <span class="grow">
                      {r.fullName}
                      {!r.tracked && (
                        <span class="muted small"> · progress not tracked</span>
                      )}
                    </span>
                    <select
                      aria-label={`Default action for ${r.fullName}`}
                      value={modes[r.fullName] ?? "file"}
                      onChange={(e) =>
                        setModes({
                          ...modes,
                          [r.fullName]: (e.target as HTMLSelectElement)
                            .value as SendMode,
                        })
                      }
                    >
                      <option value="file">File issue only</option>
                      <option value="build">File &amp; build</option>
                    </select>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section aria-labelledby="h-sites">
        <h2 id="h-sites">Sites kept on</h2>
        {kept.length === 0 ? (
          <p class="muted small">
            None. Use “Keep on for this site” in the page's ⋯ menu.
          </p>
        ) : (
          <ul class="list">
            {kept.map((origin) => (
              <li key={origin}>
                <span class="grow">{origin}</span>
                <button
                  type="button"
                  onClick={async () => {
                    await setKept(kept.filter((o) => o !== origin));
                    await chrome.permissions
                      .remove({ origins: [originPattern(origin)] })
                      .catch(() => false);
                    notifyBackground();
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="h-recent">
        <h2 id="h-recent">Recent requests</h2>
        {recent.length === 0 ? (
          <p class="muted small">Nothing yet.</p>
        ) : (
          <ul class="list">
            {recent.map((r) => (
              <li key={r.id}>
                <a
                  class="grow"
                  href={r.prUrl ?? r.issueUrl ?? r.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.title}
                </a>
                <span class="state">{summarize(r).headline ?? r.state}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Root() {
  const params = new URLSearchParams(location.hash.slice(1));
  const grant = params.get("grant");
  if (grant)
    return <Grant pattern={grant} reason={params.get("reason") ?? "keep"} />;
  return <Settings />;
}

render(<Root />, document.getElementById("app")!);
