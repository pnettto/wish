# Architecture

web-issuer has three parts: a **Chrome extension** that captures feedback, a **Cloudflare Worker** backend, and **GitHub** (hawk's `pi.yml` workflow), which does the building. `shared/` holds pure TypeScript used by both the extension and the Worker.

## 1. Components

```text
┌──────────────────────────── Chrome (extension/) ────────────────────────────┐
│                                                                             │
│  ┌─ Any web page / preview page ──────────┐      ┌─ Settings page ────────┐ │
│  │ content script (injected on demand)    │      │ Connect GitHub, default│ │
│  │  • picker.ts  → hover, click, pins     │      │ repo, preview perms,   │ │
│  │  • locator.ts → CSS locator for element│      │ recent requests        │ │
│  │  • dock UI (Send / progress)           │      └───────────┬────────────┘ │
│  │  • preview banner (Live⇄Preview, Merge)│                  │              │
│  └───────────────┬────────────────────────┘                  │              │
│        port msgs │ (messages.ts)                             │              │
│  ┌───────────────▼───────────────────────────────────────────▼────────────┐ │
│  │ background service worker (background/index.ts, api.ts, tracking.ts)   │ │
│  │  • holds opaque session token (chrome.storage)                         │ │
│  │  • calls the Worker REST API                                           │ │
│  │  • owns the WebSocket per request (polling fallback)                   │ │
│  │  • fans out RequestView updates to tabs, notifications, badge          │ │
│  └───────────────┬────────────────────────────────────────────────────────┘ │
└──────────────────┼──────────────────────────────────────────────────────────┘
                   │ HTTPS (Bearer session) + WSS  (CORS: only this extension ID)
┌──────────────────▼──────────── Cloudflare (worker/) ─────────────────────────┐
│  Worker  https://issuer.pnetto.store   (app.ts router)                       │
│   GET  /auth/start, /auth/callback  → GitHub App OAuth   (auth.ts, crypto.ts)│
│   GET  /repos                       → installed repos                        │
│   POST /issues                      → create issue       (requests.ts)       │
│   POST /requests/:id/followups      → post /pi comment                       │
│   POST /requests/:id/integrate      → squash-merge PR                        │
│   GET  /requests/:id[/live]         → snapshot / WebSocket                   │
│   POST /webhooks/github             → signed events      (webhooks.ts)       │
│        │                    │                                                │
│  ┌─────▼──────────┐   ┌─────▼──────────────────────────┐                     │
│  │ D1 (SQLite)    │   │ Durable Object RequestLive     │                     │
│  │ oauth_states   │   │ one per request id             │                     │
│  │ sessions (AES- │   │ • WebSocket fan-out            │                     │
│  │  GCM tokens)   │   │ • alarms: fail run w/o report, │                     │
│  │ requests       │   │   polling safety net, deploy   │                     │
│  │ followups      │   │   timeout                      │                     │
│  └────────────────┘   └────────────────────────────────┘                     │
└──────────────────┬───────────────────────────────▲───────────────────────────┘
     GitHub API    │ (user token → issues by       │ webhooks: workflow_run,
     (github.ts)   │  pnettto, comments, merge)    │ workflow_job, issue_comment
┌──────────────────▼───────────────────────────────┴───────────────────────────┐
│ GitHub: pnettto/hawk                                                         │
│   Issue "/pi …" ──► pi.yml workflow ──► branch + PR + preview deploy         │
│                          └──► posts "**pi:**" report comment on the issue    │
│   Merge to main ──► deploy workflow ──► production                           │
└──────────────────────────────────────────────────────────────────────────────┘

shared/ (used by both sides): issue-body.ts (formats the issue), pi-report.ts
(parses the **pi:** comment), redact.ts (strips secrets from URLs), types.ts
```

## 2. End-to-end flow

```text
You           Extension             Worker / D1 / DO              GitHub (hawk)
 │ ⌥⇧F, click   │                        │                              │
 │ pins+comments│                        │                              │
 │ Send ⌘↵ ────►│ (5s undo)              │                              │
 │              │ POST /issues ─────────►│ insert request (creating)    │
 │              │                        │ create issue "/pi …" ───────►│
 │              │◄── RequestView ────────│ state=created                │
 │              │ WSS /requests/:id/live►│ DO holds socket              │
 │              │                        │◄─ workflow_run ──────────────│ pi.yml starts
 │◄─ "Building"─│◄──── push ─────────────│ started → running            │
 │              │                        │◄─ issue_comment "**pi:**" ───│ PR + preview
 │◄─"Preview    │◄──── push ─────────────│ parse report → succeeded     │
 │   ready"     │                        │                              │
 │ Open preview │ same tab → pi-issue-N-hawk.*.workers.dev + banner     │
 │              │                        │                              │
 │ (optional) follow-up on preview:      │                              │
 │              │ POST …/followups ─────►│ "/pi …" comment ────────────►│ same branch/PR
 │              │                        │ awaiting_since reset, loop ↑ │
 │ Merge&deploy │ POST …/integrate ─────►│ squash-merge (pinned head) ─►│
 │              │                        │◄─ workflow_run (deploy) ─────│
 │◄─"Live"──────│◄──── push ─────────────│ integrating → live           │
```

## 3. Request state machine (`shared/src/types.ts`)

```text
creating → created → started → running ─┬─► succeeded ─────┐
                                        ├─► checks_failed ─┤ (integrate)
                                        ├─► no_changes     ▼
                                        └─► failed      integrating ─┬─► live
                                                                     ├─► deploy_failed
   untracked (dry run / repo not in TRACKED_REPOS)                   └─► merged (no deploy in 5 min)

   A follow-up sends any finished state back to waiting for a new report.
```

## Key design points

- **Auth:** GitHub App OAuth. GitHub tokens are stored AES-GCM-encrypted in D1; the extension only holds an opaque session token. Issues are created with the user token, so they pass `pi.yml`'s `github.actor == 'pnettto'` gate.
- **Live updates:** webhooks update D1, then the Durable Object pushes over WebSocket to the service worker, which forwards to the tab. Polling and DO alarms are a safety net for missed webhooks.
- **Safe merge:** integrate refuses if the PR has commits newer than the `**pi:**` report, so what goes live is exactly what the preview showed.
