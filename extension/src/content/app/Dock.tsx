import { isTerminalState, MERGED_STATES, type RequestView } from "@wish/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DockPrefs, Snapshot, ToBg } from "../../messages";
import { canFollowUp, hasOpenablePreview } from "../../page";
import { progressOf, summarize } from "../../tracking";

export interface DockProps {
  s: Snapshot;
  send(msg: ToBg): void;
  composer: boolean;
  setComposer(open: boolean): void;
  /** Request the next send goes to as a follow-up (preview or "Add detail"), if any. */
  target: RequestView | null;
  setFollowupFor(id: string | null): void;
  onEditComment(id: string): void;
  onHelp(): void;
  onSend(): void;
  onClose(): void;
}

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

/** Link that opens in a new tab (never navigates the annotated page). */
function Ext(props: { href: string; children: preact.ComponentChildren; class?: string }) {
  return (
    <a class={props.class ?? "link"} href={props.href} target="_blank" rel="noreferrer noopener">
      {props.children}
    </a>
  );
}

export function RequestRow({ r, send, onAddDetail }: { r: RequestView; send(msg: ToBg): void; onAddDetail(): void }) {
  const active = !isTerminalState(r.state);
  const now = useNow(active);
  const summary = summarize(r);
  const pct = progressOf(r);
  const steps = [...summary.steps.map((st) => `✓ ${st.label}`), summary.headline ?? ""].filter(Boolean).join("\n");

  if (active) {
    const label = r.state === "integrating" ? "Deploying…" : r.followupCount > 0 ? `Refining (${r.followupCount})…` : "Building…";
    const filled = Math.max(1, Math.round(pct * 4));
    return (
      <div class="req" data-state={r.state} aria-live="polite">
        <div class="progress" title={steps} tabIndex={0} aria-label={`${label} ${summary.headline ?? ""}`}>
          <span class="progress-label">{label}</span>
          <span class="bar" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} class={i < filled ? "seg on" : "seg"} />
            ))}
          </span>
          <span class="time">{elapsed(r.awaitingSince ?? r.createdAt, now)}</span>
        </div>
        <div class="sub">{summary.headline}</div>
        <div class="actions">
          {r.issueUrl && <Ext href={r.issueUrl}>Issue #{r.issueNumber}</Ext>}
          {r.runUrl ? <Ext href={r.runUrl}>View run</Ext> : r.stalled && <Ext href={r.actionsUrl}>Open Actions</Ext>}
          {r.deployRunUrl && <Ext href={r.deployRunUrl}>View deploy</Ext>}
        </div>
      </div>
    );
  }

  const dismiss = (
    <button type="button" class="icon" aria-label="Hide this request" title="Hide" onClick={() => send({ t: "request.dismiss", requestId: r.id })}>
      ×
    </button>
  );

  if (r.state === "live") {
    return (
      <div class="req done" data-state={r.state} aria-live="polite">
        <div class="head success">Live in production {dismiss}</div>
        <div class="actions">
          <button type="button" class="primary" onClick={() => send({ t: "reload" })}>
            Reload page
          </button>
          {r.prUrl && <Ext href={r.prUrl}>View PR</Ext>}
        </div>
      </div>
    );
  }

  if (r.state === "untracked") {
    return (
      <div class="req done" data-state={r.state} aria-live="polite">
        <div class="head">
          Issue #{r.issueNumber} filed {dismiss}
        </div>
        <div class="sub">{summary.headline}</div>
        <div class="actions">{r.issueUrl && <Ext href={r.issueUrl}>View issue</Ext>}</div>
      </div>
    );
  }

  const ready = (r.state === "succeeded" || r.state === "checks_failed") && hasOpenablePreview(r);
  const attention = r.state === "no_changes" || r.state === "failed" || r.state === "checks_failed" || r.state === "deploy_failed";
  return (
    <div class={`req done${attention ? " attention" : ""}`} data-state={r.state} aria-live="polite">
      <div class={`head ${summary.tone}`}>
        {ready ? (r.state === "checks_failed" ? "Preview ready · checks failing" : "Preview ready") : summary.headline}
        {dismiss}
      </div>
      {r.message && r.state !== "succeeded" && <div class="sub">{r.message}</div>}
      <div class="actions">
        {ready && (
          <button
            type="button"
            class="primary"
            title={`Opens in this tab · ${MOD}click for a new tab`}
            onClick={(e) =>
              send({ t: "preview.open", requestId: r.id, newTab: e.metaKey || e.ctrlKey, path: location.pathname + location.search + location.hash })
            }
          >
            Open preview
          </button>
        )}
        {canFollowUp(r) && (r.state === "no_changes" || r.state === "failed" || r.state === "checks_failed") && (
          <button type="button" class={ready ? "" : "primary"} onClick={onAddDetail}>
            Add detail
          </button>
        )}
        {r.prUrl && <Ext href={r.prUrl}>View PR</Ext>}
        {r.runUrl && attention && <Ext href={r.runUrl}>View run</Ext>}
        {r.deployRunUrl && <Ext href={r.deployRunUrl}>View deploy</Ext>}
        {!r.prUrl && r.issueUrl && <Ext href={r.issueUrl}>Issue #{r.issueNumber}</Ext>}
      </div>
    </div>
  );
}

function RepoChip({ s, send, disabled }: { s: Snapshot; send(msg: ToBg): void; disabled: boolean }) {
  if (s.reposError) {
    return (
      <span class="chip error" title={s.reposError}>
        Repos unavailable
      </span>
    );
  }
  if (!s.repos) return <span class="chip muted">Loading…</span>;
  if (s.repos.length === 0) {
    return (
      <span class="chip warn" title="Install the GitHub App on a repository first.">
        No repositories
      </span>
    );
  }
  const value = s.draft?.repo ?? s.repos.find((r) => r.tracked)?.fullName ?? s.repos[0]!.fullName;
  return (
    <select
      class="chip"
      aria-label="Repository"
      value={value}
      disabled={disabled}
      onChange={(e) => send({ t: "draft.setRepo", repo: (e.target as HTMLSelectElement).value })}
    >
      {s.repos.map((r) => (
        <option key={r.fullName} value={r.fullName}>
          {r.fullName}
          {r.tracked ? "" : " (untracked)"}
        </option>
      ))}
    </select>
  );
}

function Menu(props: { s: Snapshot; send(msg: ToBg): void; onHelp(): void; onClose(): void }) {
  const { s, send } = props;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    (ref.current?.querySelector("button, a") as HTMLElement | null)?.focus();
  }, []);
  const item = (label: string, fn: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        fn();
        props.onClose();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      class="menu"
      role="menu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      {s.recent.length > 0 && <div class="menu-title">Recent requests</div>}
      {s.recent.map((r) => (
        <button
          key={r.id}
          type="button"
          role="menuitem"
          class="recent"
          title={`${r.repo} · ${summarize(r).headline ?? r.state}`}
          onClick={(e) => {
            send({ t: "request.open", requestId: r.id, newTab: e.metaKey || e.ctrlKey });
            props.onClose();
          }}
        >
          <span class={`dot ${summarize(r).tone}${isTerminalState(r.state) ? "" : " active"}`} aria-hidden="true" />
          <span class="recent-title">{r.title}</span>
          <span class="recent-state">{MERGED_STATES.includes(r.state) ? r.state : r.state.replace("_", " ")}</span>
        </button>
      ))}
      {s.recent.length > 0 && <hr />}
      {s.support.ok && item(s.kept ? "Turn off for this site" : "Keep on for this site", () => send({ t: "site.keep", on: !s.kept }))}
      {item("Settings", () => send({ t: "settings.open" }))}
      {item("Shortcuts", props.onHelp)}
      {s.mode ? item("Exit feedback mode", () => send({ t: "exit" })) : item("Add feedback", () => send({ t: "mode", on: true }))}
    </div>
  );
}

function Composer(props: DockProps) {
  const { s, send, target } = props;
  const draft = s.draft!;
  const titleRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    (target ? sendRef.current : titleRef.current)?.focus();
  }, []);
  const repoReady = !!draft.repo || !!s.repos?.length;
  const disabled = target ? !canFollowUp(target) : !draft.title.trim() || !repoReady;
  return (
    <form
      class="composer"
      aria-label={target ? "Follow-up" : "New issue"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) props.onSend();
      }}
    >
      {target ? (
        <div class="composer-to">
          Refine <strong>{target.prNumber ? `PR #${target.prNumber}` : target.title}</strong>
          {target.prNumber ? <span class="muted"> · {target.title}</span> : null}
        </div>
      ) : (
        <input
          ref={titleRef}
          class="title-input"
          type="text"
          aria-label="Issue title"
          value={draft.title}
          maxLength={256}
          onInput={(e) => send({ t: "draft.setTitle", title: (e.target as HTMLInputElement).value })}
        />
      )}
      <ol class="comments">
        {draft.annotations.map((a, i) => (
          <li key={a.id}>
            <span class="num" aria-hidden="true">
              {i + 1}
            </span>
            <span class="text">{a.comment}</span>
            <button type="button" class="icon" aria-label={`Edit comment ${i + 1}`} title="Edit" onClick={() => props.onEditComment(a.id)}>
              ✎
            </button>
            <button
              type="button"
              class="icon"
              aria-label={`Delete comment ${i + 1}`}
              title="Delete"
              onClick={() => send({ t: "draft.remove", id: a.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ol>
      {!target && (
        <div class="segmented" role="radiogroup" aria-label="What to do">
          {(
            [
              ["file", "File issue only"],
              ["build", "File & build"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={s.sendMode === mode}
              class={s.sendMode === mode ? "on" : ""}
              onClick={() => send({ t: "sendMode", mode })}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!target && s.sendMode === "build" && <p class="sub">pi builds the change and deploys a preview.</p>}
      {!target && <p class="sub">Issues on public repos are visible to everyone.</p>}
      {target && !canFollowUp(target) && <p class="sub">Wait for the current run to finish before refining.</p>}
      <div class="row">
        <button
          type="button"
          onClick={() => {
            props.setComposer(false);
            props.setFollowupFor(null);
          }}
        >
          Back
        </button>
        <button ref={sendRef} type="submit" class="primary" disabled={disabled}>
          {target ? (target.prNumber ? `Send to PR #${target.prNumber}` : "Send follow-up") : "Send"} <kbd>{MOD}↵</kbd>
        </button>
      </div>
    </form>
  );
}

function Sending({ s, send }: { s: Snapshot; send(msg: ToBg): void }) {
  const sending = s.sending!;
  const now = useNow(sending.undoUntil > 0);
  const left = Math.max(0, Math.ceil((sending.undoUntil - now) / 1000));
  return (
    <div class="sending" aria-live="polite">
      <span>{sending.label}</span>
      {sending.undoUntil > now ? (
        <button type="button" class="primary" onClick={() => send({ t: "send.undo" })}>
          Undo ({left})
        </button>
      ) : (
        <span class="spinner" aria-hidden="true" />
      )}
    </div>
  );
}

/** Floating dock (bottom-right): the in-page control surface. */
export function Dock(props: DockProps) {
  const { s, send, target } = props;
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState<DockPrefs | null>(null);
  const prefs: DockPrefs = drag ?? s.dock ?? { right: 16, bottom: 16, collapsed: false };
  const count = s.draft?.annotations.length ?? 0;
  const request = s.preview ? null : s.request;

  const savePrefs = (p: DockPrefs) => send({ t: "dock.save", prefs: p });

  const onGrip = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, right: prefs.right, bottom: prefs.bottom };
    let last = prefs;
    const move = (ev: PointerEvent) => {
      last = {
        ...prefs,
        right: Math.min(Math.max(0, start.right - (ev.clientX - start.x)), window.innerWidth - 120),
        bottom: Math.min(Math.max(0, start.bottom - (ev.clientY - start.y)), window.innerHeight - 40),
      };
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      savePrefs(last);
      setTimeout(() => setDrag(null), 500);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  };

  const style = { right: `${prefs.right}px`, bottom: `${prefs.bottom}px` };

  if (prefs.collapsed) {
    const active = request && !isTerminalState(request.state);
    return (
      <div class="dock collapsed" style={style}>
        <button
          type="button"
          class="pill"
          aria-label="Expand Wish"
          onClick={() => savePrefs({ ...prefs, collapsed: false })}
        >
          <span class={`dot ${active ? "active" : count ? "accent" : ""}`} aria-hidden="true" />
          {s.sending ? "Sending…" : active ? "Building…" : count ? `${count}` : "Wish"}
        </button>
      </div>
    );
  }

  let body: preact.ComponentChildren;
  if (!s.signedIn) {
    body = (
      <div class="line">
        <span>Connect GitHub to send feedback.</span>
        <button type="button" class="primary" onClick={() => send({ t: "settings.open" })}>
          Connect GitHub
        </button>
      </div>
    );
  } else if (s.sending) {
    body = <Sending s={s} send={send} />;
  } else if (props.composer && count > 0) {
    body = <Composer {...props} />;
  } else if (s.mode || count > 0) {
    body = (
      <div class="line">
        {count === 0 ? (
          <span class="hint-text">
            {target ? "Click what should change on this preview" : "Click anything to comment"} · <kbd>Esc</kbd> to exit
          </span>
        ) : (
          <span class="count">
            <span class="dot accent" aria-hidden="true" /> {count} {count === 1 ? "comment" : "comments"}
          </span>
        )}
        {count > 0 && (
          <button type="button" class="primary" onClick={() => props.setComposer(true)}>
            Send <kbd>{MOD}↵</kbd>
          </button>
        )}
        {count > 0 && !s.mode && (
          <button type="button" onClick={() => send({ t: "mode", on: true })}>
            Add more
          </button>
        )}
      </div>
    );
  } else if (!request) {
    body = (
      <div class="line">
        <button type="button" class="primary" onClick={() => send({ t: "mode", on: true })}>
          Add feedback
        </button>
      </div>
    );
  }

  return (
    <div class="dock" style={style} role="region" aria-label="Wish">
      <div class="dock-head">
        <span class="grip" title="Drag to move" aria-hidden="true" onPointerDown={onGrip as never}>
          ⋮⋮
        </span>
        <span class="brand">Wish</span>
        {s.signedIn && !target && (s.mode || count > 0) && <RepoChip s={s} send={send} disabled={!!s.sending} />}
        {target && <span class="chip">{target.prNumber ? `PR #${target.prNumber}` : "Follow-up"}</span>}
        <span class="spacer" />
        <button type="button" class="icon" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          ⋯
        </button>
        <button type="button" class="icon" aria-label="Collapse" title="Collapse" onClick={() => savePrefs({ ...prefs, collapsed: true })}>
          –
        </button>
        {!s.mode && (
          <button type="button" class="icon" aria-label="Close" title="Close" onClick={props.onClose}>
            ×
          </button>
        )}
      </div>
      {menu && <Menu s={s} send={send} onHelp={props.onHelp} onClose={() => setMenu(false)} />}
      {request && (
        <RequestRow
          r={request}
          send={send}
          onAddDetail={() => {
            props.setFollowupFor(request.id);
            send({ t: "mode", on: true });
          }}
        />
      )}
      {body}
      {s.notice && (
        <div class={`notice ${s.notice.tone}`} role={s.notice.tone === "error" ? "alert" : "status"}>
          <span>{s.notice.text}</span>
          <button type="button" class="icon" aria-label="Dismiss" onClick={() => send({ t: "notice.dismiss" })}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
