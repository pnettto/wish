# UX plan: move web-issuer into the page

Handover document for implementing the in-page redesign. Read this file fully, then `README.md`
and `PLAN.md` (the original design; still authoritative for the Worker, webhooks, issue format
and security rules unless this file says otherwise).

> **"Continue with the plan"** means: read the Status section below, then do the items in
> "Next steps" in order, top to bottom. Stop and ask the user where a step says so.

## Status (keep this section up to date)

**Done (code in the working tree, not committed):** Phases 0–4, plus the Phase 5 shortcut sheet
(`?`) and dock drag/collapse with the position remembered per origin. **Docs** (step 1): `README.md`
rewritten for the in-page UI; note added to `PLAN.md`; `docs/github-app-setup.md` verified (no
changes needed). **Hardening** (step 2): pending sends (undo window) and grant popups are mirrored
in `chrome.storage.session` (`pendingSends`, `pendingGrants`) and restored by `Hub.ready` after a
SW restart; a send now uses the draft URL captured at Send time (before, navigating during the undo
window silently dropped it); closing the tab cancels a pending send; `navigated()` always
re-injects (the script guards re-entry). Unit tests: `extension/test/hub.test.ts` with a `chrome`
fake in `extension/test/chrome-fake.ts`. **Area annotations** (step 3): drag ≥ 6 px in feedback
mode → dashed box → comment; `kind: "area"`, locator = nearest element enclosing the corners and
centre, rect = dragged area (pin/box keep the rect in document coordinates). Drags work from
anywhere, not only empty space. Tracked with pointer events (the swallowed `pointerdown` suppresses
mouse events); Escape mid-drag cancels. E2E test added. **Onboarding** (step 4): "Get started"
checklist on the settings page (`settings/onboarding.ts`, pure + unit-tested): Connect → Allow preview
sites (skippable, `previewSkipped`) → Try it ("Take me to a page" focuses the last web tab; done
when `Hub.toggle` first turns mode on, `triedIt`). Hidden once complete. Phase 3 note: there are no real-Chrome e2e tests for the preview flow yet; only
the content-side e2e test with a fake background and unit tests for URL mapping and snapshots. Last
verified: `npm run typecheck`, `npm test` (141 tests), `npm run test:e2e` (7 tests) all green.

Where things are (differs slightly from §5.1):
- `extension/src/background/`: `index.ts` (listeners), `hub.ts` (Ports, snapshots, drafts, undo
  window, send/follow-up, integrate, preview open/swap, keep-site, grant popup, notifications),
  `state.ts` (pure `buildSnapshot`), `live.ts` (WebSocket + poll), `injection.ts`
  (executeScript, registered scripts), `api.ts` (only place with the token; settings page uses it too).
  There is no separate `previews.ts`; preview logic lives in `src/page.ts` (pure) and `hub.ts`.
- `extension/src/page.ts`: `pageSupport`, `previewUrlFor`, `productionUrlFor`,
  `previewRequestFor`, `matchesPattern`, `canFollowUp`.
- `extension/src/content/`: `index.ts` (shadow root + top-layer `popover` layer), `picker.ts`
  (selection engine only), `app/` (Preact: `App`, `Dock`, `Overlay`, `Banner`, `bridge`, `layout`),
  `styles.css` (imported `?inline`).
- `extension/src/settings/`: options page + permission "grant" window (`#grant=<pattern>&reason=`).
- `extension/static/icons/`: generated PNG icons (copied via Vite `publicDir`).
- Worker: `worker/migrations/0003_followups.sql`, `handleFollowup` in `worker/src/requests.ts`,
  tests in `worker/test/followups.test.ts`.

Gotchas learned so far:
- In the content UI, focus with **`useLayoutEffect`**, not `useEffect` (Preact defers effects to the
  next frame; the first keystrokes would hit the page). Same for syncing the picker's `busy`/start/stop.
- E2E stubs the background with `extension/test/e2e/fake-background.js` (a small reducer over
  `Snapshot`). Messages reach it asynchronously; use the `nextOf()` helper in `content.test.mjs`.
- Locators in Playwright pierce the open shadow root: `page.locator("web-issuer-overlay .dock")`.
- hawk posts follow-up reports on the **issue** (checked in hawk's `.github/workflows/pi.yml`), so PR
  copies are still ignored. The 👀 ack for a follow-up is on the comment, not the issue.
- `chrome.storage.local` is readable by content scripts; the content code simply never reads it.

### Next steps
1. ✅ **Docs** – complete.
2. ✅ **Hardening pass** – complete.
3. ✅ **Area annotations** – complete.
4. ✅ **Onboarding** – complete.
5. **Stop and ask the user** before: element screenshots (where to store images?), a real
   non-dry-run follow-up on `pnettto/hawk`, applying migration `0003` remotely
   (`npm run db:migrate:remote -w worker`) or deploying, and any commit/push.
6. **Ask the user to run the manual checklist (§7)** in real Chrome with the unpacked
   `extension/dist/` (ID `ndghjkhgmanjhlfhahcbbmpfofdmldbc`): sign-in, toggle with icon/⌥⇧F,
   reload + re-enter with pins restored, Keep on for this site, preview permission popup, banner on a
   real preview, swap, merge confirm, notification in a background tab, dark mode, reduced motion,
   keyboard only. Fix what they report.

## 0. Ground rules for the implementer

- **Never commit or push** unless the user explicitly asks in the conversation. Leave changes local.
- Talk to the user concisely; surface decisions, not essays.
- Work phase by phase (§6). After each phase: `npm test`, `npm run typecheck`, `npm run test:e2e`
  must pass, and the extension must load unpacked from `extension/dist/` with ID
  `ndghjkhgmanjhlfhahcbbmpfofdmldbc`. Summarise what changed and what you verified.
- In the Gondolin VM, Playwright uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (`/usr/bin/chromium`).
  Never run `playwright install`.
- Keep `README.md` in sync (it still describes the side panel).
- Respect reduced motion, keyboard-only use, and dark mode everywhere.

## 1. Goal

Today the page only shows a hover outline, pins and a comment box. Everything else (repo choice,
editing, review, dry run, progress, preview, merge) happens in a Chrome **side panel**. The goal is
to make the **page itself the UI** so the flow feels like one continuous thing:

> click icon → point & comment → send → watch progress → preview opens in place → refine on the
> preview → merge → back on the live page.

## 2. Decisions (made by the user, do not re-litigate)

| # | Decision |
|---|---|
| D1 | **Remove the side panel entirely.** History and settings move into the in-page dock (`⋯` menu) and a small extension page for sign-in/settings. |
| D2 | **Preview opens in the same tab** (keeps the current path + query). **⌘/Ctrl-click** opens it in a new tab. |
| D3 | Preview URLs look like `https://pi-issue-44-hawk.pedro-535.workers.dev`. Request optional host permission **`https://*.pedro-535.workers.dev/*`** once. Only show preview UI on origins that match a tracked request's `previewUrl`. |
| D4 | **Include follow-ups ("refine on preview")**: annotating a preview posts a `/pi` follow-up comment on the **same issue**, which updates the same branch/PR/preview. hawk's `pi.yml` already supports this ("Follow-up `/pi …` comments continue the same pi session"). |

## 3. Current state (as of this plan)

```text
extension/src/
  background/index.ts     sets openPanelOnActionClick, polls active requests every minute, badge
  content/index.ts        injected on demand; exposes Picker; talks to the panel via runtime messages
  content/picker.ts       shadow-DOM overlay: hover outline, pins, comment popover (plain DOM)
  content/locator.ts      selector / kind / text capture
  sidepanel/App.tsx       ALL other UI: Connect, Feedback (repo, list, edit), Review, Track, Integrate
  sidepanel/api.ts        fetch wrapper, WebSocket URL, connectGitHub (launchWebAuthFlow)
  sidepanel/draft-store.ts drafts keyed by page URL (no hash) in chrome.storage.local
  tracking.ts             RequestMap storage + summarize() → steps/headline/tone
  storage.ts, messages.ts, config.ts
worker/src/               router (app.ts), webhooks.ts, requests.ts (state machine), D1, DO live updates
shared/src/               types (RequestState, RequestView…), issue-body formatter, pi-report parser, redact
```

Important facts:
- The Worker's CORS only allows `chrome-extension://<EXTENSION_ID>`. **Content scripts can't call
  the API directly** (their fetch origin is the page). All API traffic must go through the
  service worker.
- `manifest.json` has `minimum_chrome_version: 116`, so service-worker WebSockets keep the worker alive
  while there's traffic (send a ping at least every 20 s).
- `chrome.permissions.request` **cannot** be called from a content script. It needs a user gesture
  in an extension page.
- `activeTab` grants temporary host access on toolbar click / keyboard command, with no prompt.
  It's lost on cross-origin navigation.
- Content script build: `vite.content.config.ts`, single IIFE (`dist/content.js`).

## 4. Target UX

### 4.1 Activation
- **Toolbar icon click** or **⌥⇧F** (`commands` in the manifest) toggles feedback mode in the
  current tab. No panel, no permission prompt (uses `activeTab` + `scripting.executeScript`).
- If not signed in, the dock shows **Connect GitHub**, which opens the settings page (§4.7).
- Dock `⋯` → **Keep on for this site**: requests the origin permission (via the settings page or
  a small extension popup window, see §5.5) and registers a persistent content script for that origin
  so the dock and pins come back after reloads and navigation. **Turn off for this site** reverses it.
- Unsupported pages (reuse `pageSupport()` from `App.tsx`): show a toast via `chrome.notifications`
  or the action badge/title with the reason. No silent failure.

### 4.2 The dock
A single floating element (bottom-right, draggable, position remembered per origin, collapsible to a
pill). It changes shape by state:

| State | Dock shows |
|---|---|
| Idle (feedback mode on, 0 comments) | "Click anything to comment · Esc to exit" · repo chip · `⋯` |
| Annotating (n comments) | `● n comments` · repo chip · **Send ⌘↵** · `⋯` |
| Composer | title (auto, editable) · repo chip · compact comment list · **File issue only / File & build** segmented control · **Send** |
| Sending (undo window, 5 s) | "Sending… **Undo**" |
| In progress | progress pill: `Building… ▰▰▱▱ 2:14` (steps on hover; from `summarize()`) |
| Ready | "Preview ready" · **Open preview** (⌘-click = new tab) · View PR · `⋯` |
| Needs attention (`no_changes`/`failed`/`checks_failed`) | headline + **Add detail** (opens follow-up composer) · View run |
| Live | "Live in production" · **Reload page** |

`⋯` menu: Recent requests (with states; click → jump to page / preview), Keep on for this site,
Settings, Shortcuts, Exit feedback mode.

The repo chip is a dropdown with the existing `/repos` list. The "Dry run" checkbox is replaced by the
segmented **File issue only** (= `dryRun: true`) / **File & build** (= `dryRun: false`). Remember the
choice **per repo** (default: File issue only until the user picks).

### 4.3 Annotating
- Hover outline + **label** (`button "Save" · 120×32`).
- **↑ / ↓** while hovering: select parent / first child. **Alt-click** passes the click through to the
  page (so menus can be opened, then annotated). **Esc**: close popover, then exit mode.
- **Drag** on empty space: rectangle "area" annotation (locator = nearest common ancestor; rect =
  dragged area). (Phase 5.)
- **Pins**: hover → tooltip with comment; click → popover to edit/delete in place. Pins track their
  element via `ResizeObserver` + `MutationObserver` + scroll/resize (rAF-throttled). If the element is
  gone, the pin turns grey: "Element no longer found".
- Popovers/dock/banner use the HTML **`popover` API** (top layer) inside a shadow root, so page
  z-index and modals can't cover them.
- `?` shows a shortcut sheet.

### 4.4 Sending
- **Send** (or ⌘↵) opens the composer in the dock; ⌘↵ again sends.
- **Undo window**: show "Sending… Undo" for 5 s, then call `POST /issues`. `clientRequestId` already
  makes this idempotent. Undo returns to the composer with the draft intact.
- On success: clear the draft and pins, and switch the dock to In progress for this page.

### 4.5 Progress
- The service worker owns the live connection (WebSocket + polling fallback; port the logic in
  `useLiveRequest`) and broadcasts `RequestView` updates to subscribed tabs.
- The pill persists across same-site navigation (the request is linked to the page origin, not only
  the exact URL).
- On a terminal state: `chrome.notifications` if the tab isn't focused, ✓/! badge (existing), small
  pill animation (none with reduced motion).
- Needs-attention states offer **Add detail** → follow-up composer (§4.6) instead of a new issue.

### 4.6 Preview in place
1. **Open preview** navigates the same tab to `previewOrigin + location.pathname + location.search +
   location.hash` (⌘/Ctrl-click → new tab). Record `tabId → requestId` in `chrome.storage.session`.
2. **First time only**, show a notice (modal in the page) on the preview:
   > **You're looking at a preview.** It was built automatically from PR #12 and isn't live. It runs
   > with its own data, so you may be signed out and changes here don't affect production. Don't
   > enter real or sensitive data.
   > [ ] Don't show again   **Got it**
3. **Persistent top banner** on every page of that preview origin (fixed, top layer; offsets nothing,
   but can be collapsed to a small tab on the edge):
   ```text
   ▌PREVIEW · PR #12 "Tighten header spacing" · not live   [Live ⇄ Preview]  [View PR]  [Merge & deploy]  [Exit]
   ```
   - Distinct look (amber striped left edge) so screenshots can't be mistaken for production.
   - Prefix tab title with `[Preview] ` (restore on exit).
   - **Live ⇄ Preview** (also ⌥⇧P) swaps the origin and keeps the path: production origin =
     `new URL(request.pageUrl).origin`.
   - **Merge & deploy**: confirm popover (stronger warning when `checks_failed`; copy from the current
     `Track` component), then `POST /requests/:id/integrate`. Banner follows `integrating → live`.
   - On `live`: banner becomes "Live in production · **Open live page**" (navigates to the production
     origin + same path and reloads).
   - **Exit** returns to the production origin + same path.
4. Feedback mode on a preview works as usual, but **Send** posts a **follow-up** (§5.6), labelled
   "Send to PR #12" in the composer.
5. The dock on the preview shows the request's state (a follow-up moves it back to In progress; the
   preview URL stays the same because the branch is the same).

### 4.7 Settings page (replaces the side panel's Connect screen)
`extension/src/settings/index.html` (also the `options_page`, opened on install):
- Connect / Sign out GitHub (move `connectGitHub` here; `launchWebAuthFlow` needs an extension page or
  the service worker).
- **Allow preview sites** button → `chrome.permissions.request({ origins: ["https://*.pedro-535.workers.dev/*"] })`.
- Default repo, per-repo "File issue only / File & build" default, sites with "Keep on" (remove).
- Recent requests (same list as the dock menu).

## 5. Architecture

### 5.1 Layout after the change
```text
extension/src/
  background/
    index.ts          action.onClicked, commands, install → open settings, alarms
    api.ts            moved from sidepanel/api.ts (fetch + session; only place with the token)
    live.ts           WebSocket/poll per active request, broadcast to tabs
    hub.ts            message router: content ↔ background (typed, request/response + push)
    injection.ts      activeTab inject, registerContentScripts for kept sites + preview pattern
    previews.ts       preview-origin matching, tabId → requestId (storage.session)
  content/
    index.ts          bootstrap: mount Preact app in shadow root, connect a runtime Port
    app/              Preact components: Dock, Composer, Pin, Popover, Banner, Notice, Toast
    picker.ts         hover/selection engine (keep logic; UI moves to Preact)
    locator.ts        unchanged
    styles.css        imported with ?inline and put in the shadow root
  settings/           index.html + main.tsx (Connect, permissions, preferences, history)
  shared-ui/          tokens.css, small components shared by content + settings (optional)
  drafts.ts           DraftStore (moved from sidepanel/draft-store.ts, used by background)
  tracking.ts, storage.ts, messages.ts, config.ts
```
Delete `sidepanel/` and its Vite input; remove `sidePanel` permission and `side_panel` from
`manifest.json`; stop calling `setPanelBehavior`.

### 5.2 Manifest changes
- Remove `sidePanel`; keep `storage`, `identity`, `scripting`, `activeTab`, `tabs`, `alarms`; add
  `notifications`, `webNavigation`.
- `action` without `default_popup` (so `action.onClicked` fires).
- `commands`: `toggle-feedback` (⌥⇧F), `toggle-preview` (⌥⇧P).
- `options_page`: `settings/index.html`.
- `optional_host_permissions`: keep `<all_urls>` (covers per-site and the preview pattern).
- Keep `host_permissions` for the Worker and the `key`.

### 5.3 Messaging
Use one long-lived `chrome.runtime.connect` **Port per tab** (named `wi`), so the background can
push updates and knows when a tab goes away. Define the types in `messages.ts`:

```ts
// content → background
type ToBg =
  | { t: "hello"; url: string; title: string }          // returns Snapshot
  | { t: "draft.add"; annotation: CapturedAnnotation }
  | { t: "draft.edit"; id: string; comment: string }
  | { t: "draft.remove"; id: string }
  | { t: "draft.setTitle"; title: string }
  | { t: "draft.setRepo"; repo: string }
  | { t: "send"; mode: "file" | "build" }               // background handles the undo window
  | { t: "send.undo" }
  | { t: "followup"; requestId: string }                // uses the current draft's annotations
  | { t: "integrate"; requestId: string }
  | { t: "preview.open"; requestId: string; newTab: boolean; path: string }
  | { t: "preview.exit" | "preview.swap" }
  | { t: "site.keep"; on: boolean }
  | { t: "settings.open" }
  | { t: "exit" };

// background → content (push)
type ToContent =
  | { t: "snapshot"; s: Snapshot }   // full state for this tab; send on every change (small)
  | { t: "mode"; on: boolean };

interface Snapshot {
  signedIn: boolean;
  support: { ok: true } | { ok: false; reason: string };
  repos: RepoInfo[] | null;
  draft: Draft | null;
  request: RequestView | null;          // request linked to this page/origin, if any
  preview: { request: RequestView; productionUrl: string } | null; // this tab is a preview
  sendMode: "file" | "build";
  sending: { undoUntil: number } | null;
  recent: RequestView[];
  firstPreviewNoticeSeen: boolean;
}
```
The content app is a pure view of `Snapshot` + local UI state (hover, open popover). This keeps
the token and the API in the background, and makes the content UI easy to test (feed snapshots).

### 5.4 Injection
- `action.onClicked` / `commands` → `scripting.executeScript({ files: ["content.js"] })` (guarded
  re-entry, as today), then send `{ t: "mode", on: !current }`.
- Kept sites + preview pattern: `scripting.registerContentScripts([{ id, matches, js: ["content.js"],
  runAt: "document_idle", persistAcrossSessions: true }])`. On load the content script connects; the
  background replies with a snapshot; if neither feedback mode, a draft, a tracked request nor a
  preview applies, the content script **renders nothing**.
- SPA navigation: `webNavigation.onHistoryStateUpdated` → background sends a new snapshot (page key
  changed → different draft/pins).

### 5.5 Permission prompts from the page
A content script can't call `permissions.request`. When the page needs a permission (Keep on for
this site, preview pattern not yet granted), the background opens
`settings/index.html#grant=<origin-pattern>&return=<tabId>` in a small `chrome.windows.create({ type: "popup" })`
window with one button. After the grant, it closes and the background continues the action (e.g.
navigates to the preview). First try whether calling `permissions.request` from an extension iframe
(web-accessible) inside the page works in Chrome 116+. If it does, use that instead (less jarring),
but keep the popup fallback.

If the preview permission is missing and the user declines, still open the preview (navigation
needs no permission), just without banner/notice. Show a one-line warning in the dock before
navigating.

### 5.6 Worker: follow-ups (Phase 4)
Current behaviour to change:
- `webhooks.ts › isOurRun` accepts only `run.event === "issues"`. Follow-up runs are
  `issue_comment`. Accept both.
- `applyReport`, `matchRun`, `pendingRequests` and `safetyCheck` use `issue_created_at` as "waiting since".
  Introduce **`awaiting_since`** (ms) = issue creation, and later the latest follow-up time. Reports
  posted before `awaiting_since` are ignored (so the old report doesn't count).
- Reports must still come from `github-actions[bot]` on the issue (not the PR copy). Verify with a
  real run that hawk posts the follow-up report on the **issue** when the `/pi` comment is on the
  issue. If it posts on the PR instead, accept the PR copy only when `pr_url` matches the request's PR.

New:
- Migration `0003_followups.sql`: `ALTER TABLE requests ADD COLUMN awaiting_since INTEGER;` (backfill
  from `issue_created_at`), `ADD COLUMN followup_count INTEGER NOT NULL DEFAULT 0`; table
  `followups(id TEXT PK, request_id TEXT, client_followup_id TEXT UNIQUE, comment_id INTEGER, comment_url TEXT, created_at INTEGER)`.
- `POST /requests/:id/followups` body `{ clientFollowupId, pageUrl, pageTitle?, annotations }`:
  - Owner-only (same check as `loadOwnedRequest`). Reject `dry_run` requests (409 `dry_run`), merged
    states (409 `merged`) and states still awaiting a report (409 `in_progress`).
  - Idempotent on `clientFollowupId`.
  - Posts an issue comment via the user's token. Body: `formatFollowupBody()` in
    `shared/src/issue-body.ts`, starting with `/pi Apply the follow-up changes below.`, then
    `## Page` (redacted preview URL) and `## Requested changes` (reuse `formatAnnotation`), plus a
    marker `<!-- web-issuer-followup:<id> -->`.
  - Sets `state = "created"`, `awaiting_since = now`, `followup_count += 1`, clears `run_id`/`run_url`/`message`
    (keep `pr_url`/`preview_url`), and broadcasts.
- `RequestView` gains `followupCount: number`. `summarize()` labels steps "Refinement n" when > 0.
- Integration guard (`PR_CHANGED_SKEW_MS`) keeps working because `report_at` updates on each report.
- Tests: extend `worker/test/webhooks.test.ts` + fixtures (`workflow_run.in_progress.issue_comment.json`,
  a second `issue_comment.created` report after a follow-up, an old report arriving late → ignored).
  Update `scripts/replay.mjs` fixtures list if needed.

## 6. Phases (each ends in a working, testable extension)

### Phase 0: Foundation (no visible UX change except the panel being gone)
- Move API, drafts and live tracking into the background (`background/api.ts`, `live.ts`, `hub.ts`, `drafts.ts`).
- Port-based messaging and `Snapshot` (§5.3).
- Content script becomes a Preact app in a shadow root (update `vite.content.config.ts` with the
  Preact plugin; IIFE output; CSS via `?inline`).
- Settings page with Connect/Sign out (§4.7). Remove the side panel and its manifest entries.
- Action click / ⌥⇧F toggles feedback mode via `activeTab`.
- **Done when:** you can sign in from settings, toggle the mode with the icon, add pins, reload the
  tab and re-enter mode with pins restored, and no request to the Worker originates from the content
  script (check the DevTools network panel).

### Phase 1: In-page annotate and send
- Dock (all annotate/composer/sending states), repo chip, File issue only / File & build per repo.
- Hover label, ↑/↓ traversal, Alt-click pass-through, pin hover/edit/delete, detached pins.
- Undo window; draft cleared on success.
- "Keep on for this site" + registered content scripts + popup grant flow (§5.5).
- **Done when:** a full dry-run issue can be filed without leaving the page, keyboard-only, and the
  e2e test covers hover → comment → edit → delete → send (mocked background).

### Phase 2: In-page progress
- Progress pill, needs-attention actions (View run; Add detail lands in Phase 4), notifications,
  badge, persistence across same-site navigation, Recent requests in `⋯`.
- **Done when:** `npm run replay` fixtures against a local Worker drive the pill through
  created → started → running → succeeded in an open tab, and a notification fires when the tab is
  in the background.

### Phase 3: Preview in place
- Open preview (same tab / ⌘-click new tab, path kept), preview permission flow, first-time notice,
  banner, `[Preview]` title, Live ⇄ Preview (⌥⇧P), Merge & deploy from the banner, live hand-off,
  Exit.
- **Done when:** with a seeded request whose `previewUrl` points to a second local server (e2e uses
  two `127.0.0.1` ports; make the preview pattern configurable for tests via `config.ts`), the banner
  appears only on that origin, swap keeps the path, and merge shows the confirm step.

### Phase 4: Refine on preview (follow-ups)
- Worker changes + tests (§5.6), shared `formatFollowupBody` + tests.
- Content: on a preview (or a needs-attention request), Send = "Send to PR #n" → `followup`.
  Dock returns to In progress. Banner shows "Refinement n in progress".
- **Done when:** worker tests pass; a real follow-up on `pnettto/hawk` (only when the user approves
  a non-dry run) updates the same PR/preview and the extension follows it to `succeeded`.

### Phase 5: Extras (each independent)
- Area (drag) annotations.
- Element screenshots (`tabs.captureVisibleTab` + crop). Ask the user where to store images first.
- Onboarding: on install, settings page → Connect → Allow preview sites → "Try it on this page".
- Shortcut sheet (`?`), dock drag + remembered position, collapse to pill.

## 7. Testing
- Unit (vitest): drafts, tracking/summarize, preview URL mapping (`previewUrlFor(request, location)`,
  `productionUrlFor`), snapshot reducer, follow-up formatter, worker follow-up flows.
- Content UI: render components with happy-dom from fixed `Snapshot`s (no Chrome APIs).
- E2E (`extension/test/e2e`, `node --test` + Playwright): load `dist/content.js` with a stubbed
  `chrome.runtime.connect` Port that plays the background (extend the existing stub approach in
  `picker.test.mjs`). Cover: activation, hover label, traversal keys, pin edit/delete, send with undo,
  progress pill updates, preview banner on the second origin, swap.
- Manual checklist each phase: real Chrome, unpacked build, a busy site (e.g. one with sticky headers
  and modals), dark mode, reduced motion, keyboard only.

## 8. Risks and gotchas
- **CORS / token:** never fetch the Worker from the content script; never expose the session token
  to the page (shadow root is not a security boundary, isolated world is; still keep the token out of
  content entirely).
- **SW lifetime:** WebSocket keeps the SW alive only with traffic; ping ≤ 20 s. Keep the existing
  alarm poll as a safety net.
- **activeTab is lost on navigation** to another origin. Preview pages rely on the registered content
  script for `https://*.pedro-535.workers.dev/*`.
- **Pages that fight overlays** (CSP, `pointer-events` tricks, shadow-DOM-heavy apps, iframes):
  keep the existing "top frame only" rule and show a clear message.
- **Preview has separate data/auth** (hawk: "its own URL and data"), hence the notice.
- **Follow-up report location** (issue vs PR copy) must be confirmed with a real run before relying on it.
- **Draft key** stays `pageKey(url)` (URL without hash). Preview drafts are separate from production
  drafts because the origin differs. That's intended.

## 9. Docs to update at the end
- `README.md`: remove the side-panel usage; describe activation (icon / ⌥⇧F), dock, preview banner,
  follow-ups, settings page, permissions (per-site + preview pattern).
- `PLAN.md`: add a note at the top that the UI sections are superseded by `docs/UX-PLAN.md`.
- `docs/github-app-setup.md`: no change expected (issue comments already use Issues: write). Verify.
