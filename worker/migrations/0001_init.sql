-- web-issuer initial schema (PLAN.md §5.2)
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
