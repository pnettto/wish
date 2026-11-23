# web-issuer: page feedback → GitHub issues (Chrome extension + Cloudflare backend)

> **UI superseded:** This document describes the original side-panel design. The extension now uses
> **in-page controls** (floating dock + preview banner). See **[docs/UX-PLAN.md](docs/UX-PLAN.md)**
> for the current implementation. The Worker, webhooks, issue format, tracking and security rules
> below remain authoritative; only §1 (User experience) is outdated.

A small feedback-to-GitHub tool, not a project-management tool:

**Open a page → point at what should change → submit one issue → follow the resulting automation → open the preview when changes are ready.**

The extension doesn't implement changes itself. For v1, the target repo's **existing** `/pi` GitHub workflow does the work (see §4).

This document is the full handover. Read §0 first; it overrides anything else.

---

## 0. Execution guide (read first)

### 0.1 Ground rules

- **Only touch this repository** (`web-issuer`, this folder). Do not modify, push to, open PRs on, or change settings of any other repo, including `pnettto/hawk`.
- **Do not create issues, comments, or labels on `pnettto/hawk`** unless the owner explicitly says to in the current conversation (see "Pause points"). All development testing uses fixtures and local replays.
- **Git:** `git init` locally is fine. **Never commit or push** unless the owner explicitly asks. A request to commit is not permission to push.
- **Cloudflare:** creating resources (D1 database, Worker deploy, custom domain, secrets) changes the owner's account. **Ask before the first `wrangler deploy` / `wrangler d1 create`.** Local `wrangler dev` is always fine.
- Credentials: in the dev sandbox, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set for wrangler. GitHub App secrets come from the owner (see `docs/github-app-setup.md`); never commit them. Use `.dev.vars` (gitignored) locally.
- Keep scope to this document. If something is ambiguous, pick the simplest option consistent with it and note the choice in the final summary.

### 0.2 Pause points (stop and ask the owner)

1. **Before creating Cloudflare resources** (D1 database, first deploy, custom domain `issuer.pnetto.store`).
2. **GitHub App creation.** The owner follows `docs/github-app-setup.md` and provides the Client ID, the App ID, and confirmation that secrets are set. The agent can't do this.
3. **Loading the unpacked extension in Chrome** and the first real sign-in.
4. **First real issue on hawk.** First in dry-run mode (no `/pi`, see §6.3), then one real `/pi` end-to-end run, each only on the owner's go-ahead.

Everything else (all code, tests, fixtures, docs) should be done without stopping.

### 0.3 Repository layout

npm workspaces, TypeScript everywhere, Node 22.

```text
/
├─ package.json            # workspaces: extension, worker, shared; scripts below
├─ tsconfig.base.json
├─ PLAN.md                 # this file
├─ README.md               # how to set up, run, load, deploy (write it)
├─ docs/github-app-setup.md
├─ shared/                 # pure TS, no runtime deps; used by both sides
│  └─ src/  issue-body.ts (format issue markdown), pi-report.ts (parse **pi:** comment),
│           types.ts (API request/response + RequestState), redact.ts (URL param redaction)
├─ worker/                 # Cloudflare Worker (backend)
│  ├─ wrangler.jsonc
│  ├─ migrations/0001_init.sql
│  ├─ src/  index.ts (router), auth.ts, github.ts, webhooks.ts, requests.ts,
│  │        crypto.ts (AES-GCM token encryption, HMAC verify), request-do.ts (Durable Object)
│  └─ test/ fixtures/*.json, *.test.ts
└─ extension/              # MV3, Vite + Preact
   ├─ manifest.json        # includes fixed "key" (see §5.4)
   ├─ src/  sidepanel/ (Preact app), content/ (picker), background/ (service worker)
   └─ test/
```

Root scripts: `npm run build` (all), `npm test` (vitest, all workspaces), `npm run typecheck`, `npm run dev:worker` (`wrangler dev`), `npm run build:ext` (outputs `extension/dist/` to load unpacked), `npm run replay -- <fixture>` (signs a fixture with `GITHUB_WEBHOOK_SECRET` from `.dev.vars` and POSTs it to the local worker).

Libraries: keep dependencies minimal. Preact + Vite (`@crxjs/vite-plugin` or a plain multi-entry Vite config) for the extension; plain `fetch` to the GitHub REST API (no Octokit needed); vitest for tests. No UI component library.

### 0.4 Phases and "done when"

Work through the phases in order; each must meet its checks before the next.

**Phase A: Scaffold + shared logic**
- Monorepo, configs, `.gitignore` (`node_modules`, `dist`, `.dev.vars`, `*.pem`, `.wrangler`).
- `shared/issue-body.ts`, `shared/pi-report.ts`, `shared/redact.ts` with unit tests.
- ✅ `npm test` and `npm run typecheck` pass. The parser handles every fixture in §6.2, and the formatter output matches §2 and §5.7.

**Phase B: Worker**
- D1 schema (§5.2), router, auth flow (§5.3), `/repos`, `/issues` (idempotent), `/requests/:id`, Durable Object live updates, webhook handler (§5.5), dry-run mode (§6.3).
- ✅ Tests cover: webhook signature valid/invalid, each fixture producing the right state transitions, idempotent `POST /issues` (same `clientRequestId` → same issue, GitHub called once; mock `fetch`), login allow-list rejection, unknown issue numbers ignored.
- ✅ `npm run dev:worker` + `npm run replay -- <fixture>` updates a seeded request row and pushes to a connected WebSocket.

**Phase C: Extension**
- Side panel states Connect → Annotate → Review → Track (§1), content-script picker, draft persistence, status view (WebSocket in the panel, polling fallback).
- ✅ Builds to `extension/dist/`. Unit tests for the locator builder and draft store. A Playwright smoke test (sandbox chromium at `$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`) that loads a local HTML fixture page, injects the content script, and checks that hover outline, pin placement, Escape, and the captured annotation data work. Extension-in-browser loading isn't required in CI.

**Phase D: Setup docs + deploy (pause points 1–3)**
- `README.md` and `docs/github-app-setup.md` complete and accurate.
- With approval: `wrangler d1 create`, apply migrations, set secrets, deploy to `issuer.pnetto.store`.
- ✅ `GET https://issuer.pnetto.store/health` returns ok. The owner can sign in from the extension and sees `pnettto/hawk` in the picker.

**Phase E: End-to-end (pause point 4)**
- Dry-run issue on hawk (no `/pi`) → issue link shown, status "Tracking off (dry run)". Then close the test issue via the API (with owner approval).
- One real `/pi` issue → panel goes Created → Started → Applying → Preview ready with working **Open preview** / **View PR** links.
- ✅ Owner confirms. Record findings for the "verify" items in §8.

Phase F (hardening, §7) only if the owner asks.

### 0.5 Final summary

When stopping, report: what's done per phase, test results, anything deviating from this plan, open items, and exact next steps for the owner.

---

## 1. User experience

### Open the extension

Click the toolbar icon to open a narrow side panel. Nothing appears on websites until the user explicitly opens it.

The panel contains:
- **Connect GitHub**, on first use.
- A repository picker, remembering the last choice.
- The current page’s title and domain.
- One primary button: **Add feedback**.

Only repositories authorized for the extension appear.

### Point and comment

Click **Add feedback**, then click something on the page.

- Hovering gives the target a subtle outline.
- Clicking places a small numbered pin and opens a comment field.
- Write a request such as “Make this button less prominent.”
- Save the comment and continue selecting other elements.
- Press **Escape** to leave selection mode.

The panel lists the comments, with edit and delete controls. Clicking a comment highlights its target again.

Page interaction remains normal outside selection mode. No permanent toolbar, floating chat window, or background page modification.

### Review and submit

The panel shows:
- An editable issue title.
- The page being reviewed.
- The numbered comments.
- The destination repository.

One button: **Create issue**.

Keep the draft if submission fails. Prevent accidental duplicate submissions.

### Follow progress

After submission, the same panel becomes a compact status view:

```text
Improve the pricing page
Issue #142 ↗

✓ Issue created
✓ Automation started
  Applying changes…

View workflow ↗
```

Failures get a clear message and a link to the relevant run, not a raw log viewer.

### See the result

For hawk, `/pi` deploys a per-branch preview and opens a PR. Production only changes after the PR is merged. The panel therefore shows:

> Changes are ready in a preview.

Buttons: **Open preview** (primary), **View PR**.

**Reload page** is reserved for a future flow that deploys to the original URL. A successful workflow alone does not prove the visited website has been updated.

## 2. Issue contents

One issue per feedback session, containing all comments. **The body must start with `/pi`** (required by hawk's workflow):

```markdown
/pi Apply the requested changes below.

## Page
Pricing — https://example.com/pricing

## Requested changes

### 1. Make the upgrade button less prominent
Target: button “Upgrade”
Element reference: `#pricing .card:nth-of-type(2) button`
Position: 912,184 120×40 in a 1440×900 viewport

### 2. Explain what the usage limit includes
Target: text “10,000 requests”
Element reference: `[data-testid="usage-limit"]`
Position: 640,420 180×24 in a 1440×900 viewport

<!-- web-issuer:<uuid> -->
```

For each annotation, capture:
- The user’s comment.
- A best-effort element locator.
- A short visible-text excerpt.
- The element’s position and viewport dimensions.

These references help a coding agent understand the request, but they are hints, not guaranteed permanent identifiers.

Screenshots are out of scope for v1 (privacy, storage, upload complexity).

---

## 3. Visual direction

**Calm, restrained, and mostly invisible.**

- Warm neutral background, dark readable text, one muted accent color.
- Generous spacing and small, consistent controls.
- One primary action at a time.
- Thin outlines and discreet numbered pins (render in a shadow root so page CSS can't break them, and use a high z-index).
- Status expressed through short text, not constant animation.
- Light and dark modes (`prefers-color-scheme`); respect `prefers-reduced-motion`.
- Keyboard-accessible controls and clear focus states.
- No dashboard, analytics, chat interface, settings maze, or unsolicited popups.

Four obvious states: **Connect → Annotate → Review → Track**.

---

## 4. Automation contract: pnettto/hawk `pi.yml` (existing, unchanged)

This is the only supported target in v1. Source: `.github/workflows/pi.yml` in pnettto/hawk (read-only reference; do not modify).

- **Trigger:** `issues: opened` where the issue body **starts with `/pi`** (also `issue_comment` starting with `/pi`, not used by us).
- **Actor gate:** the job only runs if `github.actor == 'pnettto'`. Therefore **issues must be created with the GitHub App's user access token** (user-to-server), so they are authored by `pnettto` (shown "via app"). An installation/bot token would create issues that never trigger a run.
- The workflow reacts 👀 on the issue, then works on branch `pi/issue-<n>`, opens a PR (`Closes #<n>`), deploys a **per-branch Cloudflare Workers preview** (URL like `https://hawk-….workers.dev`), and finally posts **one report comment** on the issue (and a copy on the PR, which has a different number, so ignore it).
- Concurrency group `pi-<issue number>`; timeout 30 min.
- Production changes only after the owner merges the PR, so the extension offers **Open preview**, never "Reload page", for hawk.

### Report comment format

Posted by `github-actions[bot]` via `gh issue comment`. The first line is one of:

| First line | Outcome |
|---|---|
| `**pi:** tests and type-check pass.` | `succeeded` |
| `**pi:** pushed, but tests or type-check still fail.` | `checks_failed` (preview/PR may still exist) |
| `**pi:** no code changes.` | `no_changes` (needs human input) |
| `**pi:** the run failed.` | `failed` |

Then optional lines, each on its own line: `PR: <url>` (omitted on the PR copy), `Preview: <url>` or `Preview deploy failed.`, `Run: <actions run url>`, then stats and a free-text summary (ignore, or show the first ~300 chars as "summary").

The parser must be tolerant: match on the `**pi:**` prefix, extract URLs with line-anchored regexes, and treat an unknown first line as `failed` with the raw first line as the message.

---

## 5. Technical design

### 5.1 Components

| Component | Responsibility |
|---|---|
| Side panel (Preact) | Connect, repo picker, annotation list, review, status (holds the WebSocket) |
| Content script (injected on demand) | Hover outline, pins, comment popover, locator capture |
| Service worker | Opens the panel on action click, routes messages, `chrome.alarms` status polling for active requests while the panel is closed, optional completion notification |
| Cloudflare Worker `web-issuer` | OAuth, GitHub API calls, webhook verification, request state |
| D1 `web-issuer` | Sessions, OAuth states, requests |
| Durable Object `RequestLive` (one per request id) | Fan out state changes to connected panels (WebSocket Hibernation API) |

MV3 service workers sleep when idle, so never rely on them for long-lived connections. All draft and active-request state lives in `chrome.storage.local`.

### 5.2 D1 schema (`worker/migrations/0001_init.sql`)

```sql
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL          -- unix ms; expire after 10 min
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- SHA-256 hex of the opaque session token
  github_login TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,      -- AES-GCM, key = TOKEN_ENC_KEY
  access_expires_at INTEGER NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL          -- session lifetime 30 days
);
CREATE TABLE requests (
  id TEXT PRIMARY KEY,                 -- uuid, also in the issue body marker
  client_request_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  repo TEXT NOT NULL,                  -- "owner/name"
  issue_number INTEGER,
  issue_url TEXT,
  issue_created_at INTEGER,
  title TEXT NOT NULL,
  page_url TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,                 -- see RequestState
  run_id INTEGER, run_url TEXT,
  pr_url TEXT, preview_url TEXT,
  message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX requests_repo_issue ON requests(repo, issue_number);
```

`RequestState` (in `shared/types.ts`): `creating` → `created` → `started` → `running` → one of `succeeded | checks_failed | no_changes | failed`. Also `untracked` (dry run, or a repo other than hawk).

### 5.3 Auth (single user)

Worker vars/secrets: `GITHUB_CLIENT_ID` (var), `GITHUB_APP_ID` (var), `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `TOKEN_ENC_KEY` (32 random bytes, base64), `ALLOWED_LOGIN` (var, `pnettto`), `EXTENSION_ID` (var), `TRACKED_REPOS` (var, `pnettto/hawk`). No app private key is needed in v1; everything uses the user token.

Flow:
1. Panel calls `chrome.identity.launchWebAuthFlow({ url: "https://issuer.pnetto.store/auth/start", interactive: true })`.
2. `/auth/start` creates an `oauth_states` row, then redirects to `https://github.com/login/oauth/authorize?client_id=…&redirect_uri=https://issuer.pnetto.store/auth/callback&state=…`.
3. `/auth/callback` validates and consumes the state, exchanges the code (`POST https://github.com/login/oauth/access_token`, JSON), calls `GET /user`, and rejects any login other than `ALLOWED_LOGIN` (redirecting with `#error=forbidden`). It stores the encrypted tokens and a new session, then redirects to `https://<EXTENSION_ID>.chromiumapp.org/cb#session=<token>`.
4. The extension stores the session token and sends `Authorization: Bearer <token>` to the Worker.
5. GitHub user tokens expire (8 h). The Worker refreshes them transparently (`grant_type=refresh_token`) and updates the row. If the refresh fails, it returns 401 and the panel shows **Connect GitHub** again.

CORS: allow origin `chrome-extension://<EXTENSION_ID>` only.

### 5.4 Fixed extension ID

`launchWebAuthFlow` redirects to `https://<id>.chromiumapp.org/`, so the unpacked extension needs a stable ID. Generate a key pair once (`openssl genrsa -out extension-key.pem 2048`, gitignored) and put the base64 DER public key in `manifest.json` `"key"`. Derive the ID (SHA-256 of the DER public key, first 32 hex chars mapped `0-f` → `a-p`) with a small script `scripts/extension-id.mjs`, and document the value in the README. Set `EXTENSION_ID` to it.

### 5.5 Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ok:true}` |
| GET | `/auth/start`, `/auth/callback` | §5.3 |
| POST | `/auth/logout` | delete session |
| GET | `/repos` | `GET /user/installations` → `GET /user/installations/{id}/repositories`; returns `[{fullName, tracked}]` |
| POST | `/issues` | body `{clientRequestId, repo, title, pageUrl, annotations[], dryRun}`. If `clientRequestId` exists, return the existing request. Otherwise insert `creating`, format the body via `shared/issue-body.ts` (prefixes `/pi` unless `dryRun`), `POST /repos/{repo}/issues` with the user token, update to `created` (or `untracked`), and return the request |
| GET | `/requests/:id` | current state (polling fallback) |
| GET | `/requests/:id/live` | WebSocket upgrade, proxied to the `RequestLive` DO. Auth via `?session=` (WebSockets can't set headers) |
| POST | `/webhooks/github` | verify `X-Hub-Signature-256` (HMAC-SHA256, constant-time compare), then dispatch on `X-GitHub-Event` |

Webhook handling (only for repos in `TRACKED_REPOS`; ignore everything else with 204):
- **`issue_comment` (action `created`):** find the request by `(repo, issue.number)`, which must not be a PR (`issue.pull_request` absent). If the comment user is `github-actions[bot]` and the body starts with `**pi:**`, parse it per §4, set the outcome, `pr_url`, `preview_url`, and `run_url`/`run_id` (from the `Run:` URL). Only the first report after `issue_created_at` counts; ignore later ones.
- **`workflow_run` / `workflow_job`:** used only for the `started`/`running` states. Candidate: `workflow_run.name == "pi"`, `event == "issues"`, `actor.login == ALLOWED_LOGIN`, `created_at` within 2 min after `issue_created_at`. If several requests are pending, prefer `display_title == issue title` (see §8). Mark `started` when `workflow_job` is `in_progress` and not skipped (the `pi` job is skipped for non-`/pi` events, so skipped jobs mean "not ours"). `workflow_run` `completed` with `conclusion` `failure`/`cancelled`/`timed_out` and no report comment within 2 min → `failed` with that run URL.
- Every state change updates D1 and calls the request's DO, which broadcasts `{type:"state", request}` to its sockets.
- Safety net: if a request has been `created` for 3 min with no `started`, any `GET /requests/:id` checks `GET /repos/{repo}/issues/{n}/reactions` for 👀 and `GET /repos/{repo}/actions/runs?event=issues&created=>=…` with the user token. If it's still `created` after 10 min, show "Automation hasn't started" with a link to the repo's Actions tab.

### 5.6 Extension details

- Manifest V3. Permissions: `sidePanel`, `storage`, `identity`, `scripting`, `activeTab`, `alarms`. `optional_host_permissions: ["<all_urls>"]`. `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`.
- **Add feedback** (a user gesture in the panel): request the origin of the current tab via `chrome.permissions.request({origins:[origin + "/*"]})` if not already granted, then `chrome.scripting.executeScript` the picker into the tab.
- Unsupported pages (`chrome://`, Web Store, `file://` without access, PDFs): show a short explanation instead of the button. Top frame only; say iframes aren't supported.
- Picker: hover outline, click → pin + inline comment popover (rendered in a shadow root), Escape exits, the page behaves normally afterwards. Capture per annotation: comment, locator (prefer `#id`, `[data-testid]`, `[aria-label]`, else a short CSS path with `:nth-of-type`), tag + role, visible-text excerpt (≤80 chars), bounding rect, viewport size, scroll position. **Never capture input values.**
- The draft (`{tabUrl, repo, title, annotations[]}`) is saved to `chrome.storage.local` on every change, keyed by tab URL. It is restored when the panel reopens and cleared only after a successful submit.
- Submit: generate a `clientRequestId` when the draft is created, disable the button while in flight, and keep the draft on error.
- Track view: WebSocket to `/requests/:id/live`, falling back to polling `/requests/:id` every 10 s. Links: Issue, View workflow (run URL), Open preview, View PR. `checks_failed` shows "Preview ready, but checks are failing", plus links.
- `chrome.alarms` (1 min) polls active requests while the panel is closed and shows a badge on completion (notifications optional; skip in v1).

### 5.7 Issue body format (`shared/issue-body.ts`)

As in §2, plus:
- First line `/pi Apply the requested changes below.` (omit in dry run; instead the first line is `> web-issuer dry run: automation not triggered.`).
- Per annotation: `### <n>. <first line of comment>`, then the full comment if it has several lines, `Target: <tag/role> “<text excerpt>”`, `Element reference: \`<locator>\``, and `Position: x,y w×h in a W×H viewport`.
- Footer: `<!-- web-issuer:<request id> -->`.
- The page URL is passed through `shared/redact.ts` (drop or redact query params matching `token|key|secret|session|auth|code|password|sig` case-insensitively; drop the fragment).
- **pnettto/hawk is a public repo, so issues are public.** The Review screen shows this as a single line: "Issues on public repos are visible to everyone."

---

## 6. Testing

### 6.1 Principles

Unit-test the pure modules thoroughly, test the Worker with mocked `fetch` (GitHub) plus fixture webhooks, and give the picker a Playwright smoke test against a local HTML page. No real GitHub calls in automated tests.

### 6.2 Fixtures (`worker/test/fixtures/`)

Report comment bodies (exact first lines and line structure from hawk's `pi.yml`):

```text
**pi:** tests and type-check pass.

PR: https://github.com/pnettto/hawk/pull/143
Preview: https://hawk-pi-issue-142.example.workers.dev
Run: https://github.com/pnettto/hawk/actions/runs/1234567890
<stats lines from stats.sh: format varies, ignore>

Made the upgrade button secondary and added a tooltip explaining usage limits.
```

```text
**pi:** pushed, but tests or type-check still fail.

PR: https://github.com/pnettto/hawk/pull/143
Preview deploy failed.
Run: https://github.com/pnettto/hawk/actions/runs/1234567890
```

```text
**pi:** no code changes.

Run: https://github.com/pnettto/hawk/actions/runs/1234567890
```

```text
**pi:** the run failed.

Run: https://github.com/pnettto/hawk/actions/runs/1234567890
```

Minimal webhook payloads (write full JSON fixtures with these fields; the real payloads contain more):

```jsonc
// issue_comment.created.json   (X-GitHub-Event: issue_comment)
{ "action": "created",
  "issue": { "number": 142, "title": "Improve the pricing page", "html_url": "https://github.com/pnettto/hawk/issues/142" },
  "comment": { "id": 1, "body": "**pi:** tests and type-check pass.\n\nPR: …", "user": { "login": "github-actions[bot]", "type": "Bot" }, "created_at": "2026-11-23T10:05:00Z" },
  "repository": { "full_name": "pnettto/hawk" } }

// workflow_run.in_progress.json   (X-GitHub-Event: workflow_run)
{ "action": "in_progress",
  "workflow_run": { "id": 1234567890, "name": "pi", "event": "issues", "status": "in_progress", "conclusion": null,
    "display_title": "Improve the pricing page", "html_url": "https://github.com/pnettto/hawk/actions/runs/1234567890",
    "created_at": "2026-11-23T10:00:05Z", "actor": { "login": "pnettto" } },
  "repository": { "full_name": "pnettto/hawk" } }

// workflow_job.in_progress.json   (X-GitHub-Event: workflow_job)
{ "action": "in_progress",
  "workflow_job": { "run_id": 1234567890, "name": "pi", "workflow_name": "pi", "status": "in_progress", "conclusion": null,
    "html_url": "https://github.com/pnettto/hawk/actions/runs/1234567890/job/1" },
  "repository": { "full_name": "pnettto/hawk" } }
```

Also include: a skipped job (`status: completed, conclusion: skipped`), a failed run (`workflow_run completed/failure`), the PR copy of the report (`issue.pull_request` present), a comment from a non-bot user, a different repo, and a bad signature.

### 6.3 Dry-run mode

A "Dry run" toggle on the Review screen (default **on** until the owner turns it off; remembered in storage). Dry-run issues have no `/pi`, start with the dry-run notice (§5.7), and are tracked as `untracked`. This allows a real issue-creation test on hawk without starting a `pi` run.

---

## 7. Hardening (Phase F, only on request) and out of scope

Hardening: navigation mid-annotation (keep the draft per URL; re-highlight what can be found), changed layouts (locator not found → show "element not found" without breaking), expired sessions, lost connections, double clicks, closed panels, a privacy review of the captured data.

Out of scope for v1: screenshots, video, team discussions, other Git providers, code editing in the extension, a log viewer, follow-up `/pi` comments from the panel, notifications, the Chrome Web Store, multiple users, and repos other than hawk being *tracked* (other installed repos can receive issues, shown as `untracked`).

---

## 8. Verify during the end-to-end run

- An issue created with the user token triggers `pi.yml` (actor `pnettto`). This is expected; confirm it.
- The `display_title` of `issues`-triggered `pi` runs (expected: the issue title). If it's different, rely on timing plus the report comment's `Run:` URL.
- The exact preview URL shape from the report (the regex should accept any `https://…` after `Preview: `).
- Webhook delivery to `issuer.pnetto.store` (check "Recent deliveries" in the GitHub App settings).
