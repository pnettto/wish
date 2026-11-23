// Plays the background service worker for e2e tests: a stubbed
// chrome.runtime.connect Port and a tiny reducer over a Snapshot.
// Injected with page.addInitScript before content.js runs.
(() => {
  const now = () => Date.now();
  const base = {
    url: location.href,
    signedIn: true,
    support: { ok: true },
    mode: false,
    repos: [
      { fullName: "pnettto/hawk", tracked: true },
      { fullName: "pnettto/other", tracked: false },
    ],
    reposError: null,
    draft: null,
    request: null,
    preview: null,
    sendMode: "file",
    sending: null,
    recent: [],
    firstPreviewNoticeSeen: true,
    kept: false,
    notice: null,
    dock: null,
  };
  const init = window.__initialSnapshot ?? {};
  const state = { ...base, ...init, url: location.href };
  const sent = (window.__sent = []);
  let listener = null;
  let timer = null;
  let n = 0;

  const push = () => listener?.({ t: "snapshot", s: structuredClone(state) });
  window.__state = state;
  window.__push = (patch) => {
    Object.assign(state, patch);
    push();
  };

  const title = (d) => {
    if (d.titleEdited) return d.title;
    const first = d.annotations[0]?.comment.split("\n")[0] ?? "";
    return d.annotations.length > 1 ? `${first} (+${d.annotations.length - 1} more)` : first || "Page feedback";
  };
  const draft = () =>
    (state.draft ??= { clientRequestId: "c1", tabUrl: location.href, pageTitle: document.title, repo: "pnettto/hawk", title: "", titleEdited: false, annotations: [], createdAt: now(), updatedAt: now() });
  const save = () => {
    state.draft.title = title(state.draft);
    if (state.draft.annotations.length === 0) state.draft = null;
  };

  const view = (over) => ({
    id: "r1", clientRequestId: "c1", repo: "pnettto/hawk", title: state.draft?.title ?? "t", pageUrl: location.href, dryRun: false,
    state: "created", issueNumber: 142, issueUrl: "https://github.com/pnettto/hawk/issues/142", runId: null, runUrl: null,
    prUrl: null, previewUrl: null, prNumber: null, deployRunUrl: null, message: null, stalled: false,
    actionsUrl: "https://github.com/pnetto/hawk/actions", followupCount: 0, awaitingSince: now(), createdAt: now(), updatedAt: now(), ...over,
  });

  const handle = (m) => {
    sent.push(m);
    switch (m.t) {
      case "hello": state.url = m.url; break;
      case "mode": state.mode = m.on; break;
      case "exit": state.mode = false; break;
      case "draft.add": draft().annotations.push({ ...m.annotation, id: `a${++n}` }); save(); break;
      case "draft.edit": state.draft.annotations = state.draft.annotations.map((a) => (a.id === m.id ? { ...a, comment: m.comment } : a)); save(); break;
      case "draft.remove": state.draft.annotations = state.draft.annotations.filter((a) => a.id !== m.id); save(); break;
      case "draft.setTitle": state.draft.title = m.title; state.draft.titleEdited = m.title.trim() !== ""; break;
      case "draft.setRepo": state.draft.repo = m.repo; break;
      case "sendMode": state.sendMode = m.mode; break;
      case "send":
      case "followup": {
        const undoMs = window.__undoMs ?? 5000;
        state.sending = { undoUntil: now() + undoMs, label: m.t === "send" ? "Filing issue in pnettto/hawk…" : "Sending to PR #143…" };
        timer = setTimeout(() => {
          state.sending = null;
          if (m.t === "send") state.request = view({ dryRun: m.mode === "file", state: m.mode === "file" ? "untracked" : "created" });
          else state.preview = { ...state.preview, request: { ...state.preview.request, state: "created", followupCount: 1 } };
          state.draft = null;
          state.mode = false;
          push();
        }, undoMs);
        break;
      }
      case "send.undo": clearTimeout(timer); state.sending = null; break;
      case "preview.noticeSeen": state.firstPreviewNoticeSeen = true; break;
      case "dock.save": state.dock = m.prefs; break;
      case "notice.dismiss": state.notice = null; break;
      default: break;
    }
    push();
  };

  window.chrome = {
    runtime: {
      id: "test",
      connect: () => ({
        name: "wi",
        postMessage: (m) => setTimeout(() => handle(structuredClone(m)), 0),
        onMessage: { addListener: (fn) => (listener = fn), removeListener() {} },
        onDisconnect: { addListener() {}, removeListener() {} },
        disconnect() {},
      }),
    },
  };
})();
