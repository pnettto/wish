-- Local-only seed for `npm run replay` (never run against the remote DB).
-- Session token: "dev-session-token" (WebSocket: ?session=dev-session-token).
-- Access/refresh token columns hold placeholders; GitHub calls won't work
-- with this session, but /requests/:id and /requests/:id/live do.
INSERT OR REPLACE INTO sessions (id, github_login, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at, created_at, expires_at)
VALUES ('7fef60999ea6a84de15934221684243e184aff47f2383ab23e0b4e5b88c534af', 'pnettto', 'placeholder', 4102444800000, 'placeholder', 4102444800000, 1795428000000, 4102444800000);

-- Issue #142 on pnettto/hawk, created 2026-11-23T10:00:00Z, matching the fixtures.
INSERT OR REPLACE INTO requests (id, client_request_id, github_login, repo, issue_number, issue_url, issue_created_at,
  title, page_url, dry_run, state, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000142', 'seed-142', 'pnettto', 'pnettto/hawk', 142,
  'https://github.com/pnettto/hawk/issues/142', 1795428000000, 'Improve the pricing page',
  'https://example.com/pricing', 0, 'created', 1795428000000, 1795428000000);
