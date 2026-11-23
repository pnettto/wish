# Wish

> Formerly `web-issuer`. Deployed infrastructure keeps the old name: the Cloudflare Worker and D1 database are `web-issuer`, and issues carry `<!-- web-issuer:… -->` markers.

Page feedback → GitHub issues. Click the toolbar icon (or press **⌥⇧F**) to enter feedback mode on any page. Point at elements, comment on them, and file **one** issue. For `pnettto/hawk`, the issue starts with `/pi`, so hawk's existing `pi.yml` workflow implements the change, deploys a preview, and opens a PR. A floating dock shows progress and opens the preview in place. You can refine changes on the preview (follow-ups), then merge directly to production.

See [PLAN.md](PLAN.md) for the original design; [docs/UX-PLAN.md](docs/UX-PLAN.md) describes the in-page UI redesign.

```text
extension/  MV3 extension (Preact side panel, on-demand content-script picker, service worker)
worker/     Cloudflare Worker: GitHub App OAuth, issue creation, webhooks, D1, Durable Object live updates
shared/     Pure TS used by both: issue body formatter, **pi:** report parser, URL redaction, API types
scripts/    extension-id.mjs (stable extension ID), replay.mjs (replay signed webhook fixtures locally)
docs/       github-app-setup.md
```

## Requirements

- Node 22+ and npm
- A Cloudflare account (`wrangler` is installed as a dev dependency)
- Chrome 116+

```sh
npm install
npm test            # vitest: shared, worker, extension unit tests
npm run typecheck
npm run test:e2e    # builds the extension, then runs the Playwright picker smoke test
```

The Playwright test needs a Chromium. It uses `$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if set, otherwise Playwright's own browser (`npx playwright install chromium`).

## Extension ID

The unpacked extension has a fixed ID so the OAuth redirect (`https://<id>.chromiumapp.org/cb`) is stable:

```text
ndghjkhgmanjhlfhahcbbmpfofdmldbc
```

It is derived from the public key in `extension/manifest.json` (`"key"`). The matching private key is `extension-key.pem` in the repo root (gitignored; keep it if you ever want to pack the extension). `npm run extension-id` prints the ID; `npm run extension-id -- --init` creates a key if none exists.

`EXTENSION_ID` in `worker/wrangler.jsonc` must match. The Worker only allows CORS from `chrome-extension://<EXTENSION_ID>`.

## Build and load the extension

```sh
npm run build:ext                                   # → extension/dist/
VITE_API_BASE=http://localhost:8787 npm run build:ext   # point at a local Worker instead
VITE_PREVIEW_PATTERN="http://127.0.0.1/*" npm run build:ext  # match a local preview origin
```

`VITE_PREVIEW_PATTERN` defaults to `https://*.pedro-535.workers.dev/*` (hawk's preview domain). Override it if you're testing with a different preview origin.

Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist/`. Check that the ID shown is `ndghjkhgmanjhlfhahcbbmpfofdmldbc`. Pin the toolbar icon.

## Usage

### First run

1. Click the toolbar icon or press **⌥⇧F** (Option-Shift-F on macOS, Alt-Shift-F on Windows/Linux). A floating dock appears on the page.
2. If not signed in, the dock shows **Connect GitHub** → opens the settings page → **Connect GitHub** button → GitHub authorization.
3. Chrome requests **Allow preview sites** in settings for the preview pattern (e.g. `*.pedro-535.workers.dev`). Grant it once to see the preview banner and swap between live/preview.

### Annotating a page

1. **Click the toolbar icon or ⌥⇧F** to enter feedback mode (or select "Keep on for this site" from the dock's `⋯` menu so it persists across reloads).
2. **Hover** over elements to see an outline. **Click** to place a numbered pin and comment. **Alt-click** passes the click through (e.g. to open a menu before annotating it). **↑/↓** selects parent/child while hovering. **Esc** closes any open popover, then exits feedback mode.
3. The dock's repo chip lets you pick the destination. It remembers your last choice.
4. Click a pin to edit or delete its comment. Press **?** for the full shortcut sheet.

### Sending feedback

1. When you have comments, the dock shows **Send ⌘↵**. Click it (or press ⌘↵) to open the composer in the dock.
2. The title is generated from the page; you can edit it. The dock shows a compact list of your comments.
3. Choose **File issue only** (default; no `/pi`, no automation) or **File & build** (starts the `/pi` workflow). Your choice is remembered **per repo**.
4. Click **Send**. The dock shows "Sending… **Undo**" for 5 seconds. After that, the issue is created and the dock switches to progress tracking.

### Tracking progress

The dock persists across same-site navigation and shows live updates:

- **Building… ▰▰▱▱ 2:14** – workflow in progress (hover for step details)
- **Preview ready** – **Open preview** (⌘-click for new tab) / **View PR**
- **Needs attention** (e.g. no changes found, checks failed) – **Add detail** to send a follow-up, or **View run**

If the tab isn't focused when a workflow finishes, you'll see a system notification and a badge on the toolbar icon.

### Previewing changes in place

1. **Open preview** navigates the same tab to the preview origin (`https://pi-issue-N-hawk.pedro-535.workers.dev`) with the same path and query. First-time users see a notice explaining the preview environment.
2. A **banner** appears at the top of every preview page:
   ```
   ▌PREVIEW · PR #12 "Tighten header spacing" · not live   [Live ⇄ Preview]  [View PR]  [Merge & deploy]  [Exit]
   ```
   - Distinct amber striped left edge so screenshots can't be mistaken for production.
   - **Live ⇄ Preview** (also ⌥⇧P) swaps to the production origin, keeping the path.
   - **Merge & deploy** shows a confirmation popover, then integrates.
   - **Exit** returns to the production origin + same path.
3. The page title is prefixed with `[Preview]` while you're on the preview. It's restored on exit. 

## Worker

### Configuration

Non-secret vars live in `worker/wrangler.jsonc` (`GITHUB_CLIENT_ID`, `GITHUB_APP_ID`, `ALLOWED_LOGIN`, `EXTENSION_ID`, `TRACKED_REPOS`, `PUBLIC_URL`). Secrets are set with `wrangler secret put`: `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `TOKEN_ENC_KEY` (`openssl rand -base64 32`). See [docs/github-app-setup.md](docs/github-app-setup.md).

### Local development

```sh
cp worker/.dev.vars.example worker/.dev.vars   # fill in TOKEN_ENC_KEY etc.
npm run db:migrate:local
npm run db:seed:local       # request for pnettto/hawk#142 + session "dev-session-token"
npm run dev:worker          # wrangler dev on http://localhost:8787
```

Replay webhook fixtures (signed with `GITHUB_WEBHOOK_SECRET` from `.dev.vars`) against the local Worker:

```sh
npm run replay -- workflow_run.in_progress   # seeded request → started
npm run replay -- workflow_job.in_progress   # → running
npm run replay -- issue_comment.created      # → succeeded, PR + preview URLs
curl -H 'Authorization: Bearer dev-session-token' \
  http://localhost:8787/requests/00000000-0000-4000-8000-000000000142
```

To watch the live push, connect a WebSocket first, e.g. `npx wscat -c 'ws://localhost:8787/requests/00000000-0000-4000-8000-000000000142/live?session=dev-session-token'`. Re-run `npm run db:seed:local` to reset the request. Fixtures are in `worker/test/fixtures/`.

Signing in against a local Worker requires adding `http://localhost:8787/auth/callback` as an extra callback URL on the GitHub App and `PUBLIC_URL=http://localhost:8787` in `.dev.vars`.

`wrangler dev` needs workerd, which doesn't run on musl (Alpine) Linux. Run it on macOS or a glibc Linux.

### Deploy (owner)

```sh
cd worker
npx wrangler d1 create web-issuer          # paste the database_id into wrangler.jsonc
npm run db:migrate:remote
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put TOKEN_ENC_KEY
npx wrangler deploy                        # also attaches the custom domain issuer.pnetto.store
curl https://issuer.pnetto.store/health    # {"ok":true}
```

The `pnetto.store` zone must be on the same Cloudflare account for the custom domain.

### Refining on the preview (follow-ups)

1. Enter feedback mode on the preview (icon or ⌥⇧F). The dock's **Send** button is labelled "Send to PR #N".
2. Annotate what still needs changing and send. This posts a `/pi` follow-up comment on the **same issue**, which updates the same branch, PR, and preview URL.
3. The dock goes back to "Building…" → "Preview ready". The preview origin stays the same.
4. Repeat as needed. Each follow-up increments the request's `followup_count`.

### Merging to production

1. On the preview, the banner offers **Merge & deploy**. A popover confirms (with an extra warning if checks failed).
2. The dock switches to **Integrating…** → **Live in production** (or **Deploy failed** if the `deploy` workflow fails).
3. The **Integrate** endpoint squash-merges the PR (refusing if new commits appeared after the report, to ensure what you saw in the preview is what goes live), then follows the `deploy` workflow run. If no deploy run appears within 5 minutes, the request ends as `merged` (e.g. docs-only changes).
4. When live, the banner offers **Open live page** (navigates to the production origin + same path).

### Switching between live and preview

The preview banner's **Live ⇄ Preview** button (or **⌥⇧P**) swaps between the production and preview origins, keeping the path and query. The dock reflects the current page's request (if any).

### Settings and permissions

The **settings page** (`chrome://extensions` → Wish → **Extension options**, or the dock's `⋯` → **Settings**) has:

- **Connect / Sign out GitHub**
- **Allow preview sites** – requests permission for the preview pattern once (e.g. `https://*.pedro-535.workers.dev/*`). Without it, the preview banner and swap won't work.
- Default repo, per-repo "File issue only / File & build" preference, and sites where "Keep on for this site" is active (remove button).
- Recent requests (same list as the dock `⋯` menu).

The extension uses:

- **`activeTab`** – temporary access on icon click / ⌥⇧F, no prompt.
- **Optional host permissions** – requested on first annotation after sign-in for the current origin, or via "Keep on for this site" to persist the dock across reloads. Also requested once for the preview pattern.
- **`notifications`**, **`webNavigation`**, **`alarms`** for progress updates.

All host permissions are optional; you're only prompted for sites you explicitly annotate or keep.

## How tracking works

- Issues are created with the GitHub App's **user** token, so they're authored by `pnettto` and pass the `github.actor == 'pnettto'` gate in hawk's `pi.yml`.
- **Follow-ups** (migration `0003_followups.sql`): annotating a preview posts a `/pi` comment on the same issue. `awaiting_since` and `followup_count` track the current automation round. Reports and runs older than `awaiting_since` are ignored. Hawk's `pi.yml` already supports follow-up comments: "Follow-up `/pi …` comments continue the same pi session."
- `workflow_run` (`pi`, event `issues`, created ≤ 2 min after the issue; title match breaks ties) → **started**; `workflow_job` in progress → **running**; a skipped `pi` job means "not ours" and unlinks the run.
- The `**pi:**` report comment from `github-actions[bot]` on the issue (not the PR copy) sets the outcome: `succeeded`, `checks_failed`, `no_changes` or `failed`, with PR, preview and run links. The first report after `awaiting_since` counts; earlier ones are ignored.
- **Integrate changes** (`POST /requests/:id/integrate`) squash-merges the PR, pinned to its current head commit. It refuses if the PR got commits after the `**pi:**` report (i.e. not what the preview showed). It then tracks the `deploy` workflow run (`push`) whose `head_sha` is the merge commit: `integrating` → `live` or `deploy_failed`. If no deploy run appears within 5 minutes (e.g. docs-only changes), the request ends as `merged`.
- A run that ends in `failure`/`cancelled`/`timed_out` without a report within 2 minutes is marked failed (Durable Object alarm).
- Safety net for missed webhooks: from 3 minutes after creation (or the last follow-up), polling looks for the `**pi:**` report comment on the issue, the matching run and the 👀 reaction through the API; after 10 minutes without a start the dock says "Automation hasn't started" and links the Actions tab. After a merge, polling also looks up the deploy run by commit. Follow-up comments also get a 👀 reaction from `pnettto` as an ack.
- The service worker owns the live connection (WebSocket + polling fallback) and broadcasts `RequestView` updates to subscribed tabs. Each tab listens to its own port for snapshots. The dock persists across same-site navigation.
- Dry runs and repos outside `TRACKED_REPOS` are `untracked`: the issue is created, progress isn't followed.

## Privacy

- Captured per comment: your text, a CSS locator, tag/role, up to 80 characters of visible text, the element's position, viewport size and scroll. Form field values are never captured (labels/placeholders only). No screenshots.
- Page URLs in issues drop the fragment and redact query values whose names contain `token`, `key`, `secret`, `session`, `auth`, `code`, `password` or `sig`.
- Issues on public repos (like hawk) are public.
- GitHub tokens are stored AES-GCM-encrypted in D1; the extension only holds an opaque session token.
