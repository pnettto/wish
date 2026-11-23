# web-issuer

Page feedback → GitHub issues. A Chrome side panel lets you point at elements on any page, comment on them, and file **one** issue. For `pnettto/hawk`, the issue starts with `/pi`, so hawk's existing `pi.yml` workflow implements the change, deploys a preview, and opens a PR. The panel follows progress and shows **Open preview** / **View PR** at the end.

See [PLAN.md](PLAN.md) for the full design.

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
```

Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist/`. Check that the ID shown is `ndghjkhgmanjhlfhahcbbmpfofdmldbc`. Pin the toolbar icon; clicking it opens the side panel.

Usage: **Connect GitHub** → pick the repository → **Add feedback** (Chrome asks for access to the current site once) → click elements and write comments → **Esc** to stop → **Review** → **Create issue**. The **Dry run** toggle is on by default: dry-run issues have no `/pi`, so no automation starts. Turn it off when you want the real thing.

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

## How tracking works

- Issues are created with the GitHub App's **user** token, so they're authored by `pnettto` and pass the `github.actor == 'pnettto'` gate in hawk's `pi.yml`.
- `workflow_run` (`pi`, event `issues`, created ≤ 2 min after the issue; title match breaks ties) → **started**; `workflow_job` in progress → **running**; a skipped `pi` job means "not ours" and unlinks the run.
- The `**pi:**` report comment from `github-actions[bot]` on the issue (not the PR copy) sets the outcome: `succeeded`, `checks_failed`, `no_changes` or `failed`, with PR, preview and run links. Only the first report counts.
- A run that ends in `failure`/`cancelled`/`timed_out` without a report within 2 minutes is marked failed (Durable Object alarm).
- Safety net: if nothing happened 3 minutes after creation, polling checks the 👀 reaction and recent runs through the API; after 10 minutes the panel says "Automation hasn't started" and links the Actions tab.
- The panel listens on a WebSocket (`/requests/:id/live`) and polls every 10 s as a fallback. While the panel is closed, the service worker polls once a minute and sets a badge when done.
- Dry runs and repos outside `TRACKED_REPOS` are `untracked`: the issue is created, progress isn't followed.

## Privacy

- Captured per comment: your text, a CSS locator, tag/role, up to 80 characters of visible text, the element's position, viewport size and scroll. Form field values are never captured (labels/placeholders only). No screenshots.
- Page URLs in issues drop the fragment and redact query values whose names contain `token`, `key`, `secret`, `session`, `auth`, `code`, `password` or `sig`.
- Issues on public repos (like hawk) are public.
- GitHub tokens are stored AES-GCM-encrypted in D1; the extension only holds an opaque session token.
