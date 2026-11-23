import { INTEGRATABLE_STATES, isTerminalState, MERGED_STATES, type RequestView } from "@web-issuer/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ToBg } from "../../messages";
import { summarize } from "../../tracking";

const PREFIX = "[Preview] ";

/** Prefix the tab title while on a preview; restore it on exit. */
export function usePreviewTitle(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const apply = () => {
      if (!document.title.startsWith(PREFIX)) document.title = PREFIX + document.title;
    };
    apply();
    const titleEl = () => document.querySelector("title");
    const mo = new MutationObserver(apply);
    const observe = () => {
      const t = titleEl();
      if (t) mo.observe(t, { childList: true, characterData: true, subtree: true });
      if (document.head) mo.observe(document.head, { childList: true });
    };
    observe();
    return () => {
      mo.disconnect();
      if (document.title.startsWith(PREFIX)) document.title = document.title.slice(PREFIX.length);
    };
  }, [on]);
}

export function PreviewBanner(props: { r: RequestView; productionUrl: string; send(msg: ToBg): void }) {
  const { r, send } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const pr = r.prNumber ? `PR #${r.prNumber}` : "PR";
  const canMerge = INTEGRATABLE_STATES.includes(r.state) && !!r.prUrl && !r.dryRun;
  const merged = MERGED_STATES.includes(r.state);
  const active = !isTerminalState(r.state);

  useEffect(() => {
    if (r.state !== "succeeded" && r.state !== "checks_failed") {
      setMerging(false);
      setConfirming(false);
    }
  }, [r.state]);

  if (collapsed) {
    return (
      <button type="button" class="banner-tab" aria-label="Show preview banner" onClick={() => setCollapsed(false)}>
        PREVIEW
      </button>
    );
  }

  let status: preact.ComponentChildren;
  if (r.state === "live") status = <strong>Live in production</strong>;
  else if (r.state === "integrating") status = <span>Merged · deploying to production…</span>;
  else if (merged) status = <span>{summarize(r).headline}</span>;
  else if (active) status = <span>{r.followupCount > 0 ? `Refinement ${r.followupCount} in progress…` : "Building…"}</span>;
  else if (r.state === "checks_failed") status = <span class="warn-text">checks failing</span>;
  else status = <span>not live</span>;

  return (
    <div class="banner" role="region" aria-label="Preview">
      <span class="banner-tag">PREVIEW</span>
      <span class="banner-text">
        {pr} <span class="banner-title">“{r.title}”</span> · {status}
      </span>
      <span class="spacer" />
      {r.state === "live" ? (
        <button type="button" class="primary" onClick={() => location.assign(props.productionUrl)}>
          Open live page
        </button>
      ) : (
        <>
          <button type="button" title="Swap to the live site (⌥⇧P)" onClick={() => send({ t: "preview.swap" })}>
            Live ⇄ Preview
          </button>
          {r.prUrl && (
            <a class="button" href={r.prUrl} target="_blank" rel="noreferrer noopener">
              View PR
            </a>
          )}
          {canMerge && (
            <span class="merge-wrap">
              <button type="button" class={r.state === "checks_failed" ? "danger" : "primary"} onClick={() => setConfirming(!confirming)} aria-expanded={confirming}>
                Merge & deploy
              </button>
              {confirming && (
                <div class="confirm" role="alertdialog" aria-label="Merge and deploy">
                  <p>This squash-merges {pr} into the default branch and deploys it to production.</p>
                  {r.state === "checks_failed" && <p class="warn-text">Tests or type-check are failing on this PR. Merging may break production.</p>}
                  <div class="row">
                    <button type="button" onClick={() => setConfirming(false)} disabled={merging}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      class={r.state === "checks_failed" ? "danger" : "primary"}
                      disabled={merging}
                      onClick={() => {
                        setMerging(true);
                        send({ t: "integrate", requestId: r.id });
                      }}
                    >
                      {merging ? "Merging…" : "Merge and deploy"}
                    </button>
                  </div>
                </div>
              )}
            </span>
          )}
        </>
      )}
      <button type="button" onClick={() => send({ t: "preview.exit" })}>
        Exit
      </button>
      <button type="button" class="icon" aria-label="Collapse banner" title="Collapse" onClick={() => setCollapsed(true)}>
        ⌃
      </button>
    </div>
  );
}

export function PreviewNotice(props: { r: RequestView; onDone(forever: boolean): void }) {
  const [forever, setForever] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  return (
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="wi-notice-title">
        <h2 id="wi-notice-title">You're looking at a preview.</h2>
        <p>
          It was built automatically from {props.r.prNumber ? `PR #${props.r.prNumber}` : "a pull request"} and isn't live. It runs with its own data, so
          you may be signed out and changes here don't affect production. Don't enter real or sensitive data.
        </p>
        <div class="row">
          <label class="check">
            <input type="checkbox" checked={forever} onChange={(e) => setForever((e.target as HTMLInputElement).checked)} /> Don't show again
          </label>
          <button ref={ref} type="button" class="primary" onClick={() => props.onDone(forever)}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌥⇧F", "Toggle feedback mode"],
  ["⌥⇧P", "Swap live ⇄ preview"],
  ["Click / Enter", "Comment on the highlighted element"],
  ["Drag", "Comment on an area"],
  ["Alt-click", "Click through to the page"],
  ["↑ / ↓", "Select parent / first child"],
  ["Tab", "Highlight the next focusable element"],
  ["⌘/Ctrl ↵", "Send (opens the composer, then sends)"],
  ["Esc", "Close, then exit feedback mode"],
  ["?", "This sheet"],
];

export function ShortcutSheet(props: { onClose(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Shortcuts</h2>
        <dl class="shortcuts">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div class="row">
          <button ref={ref} type="button" class="primary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
