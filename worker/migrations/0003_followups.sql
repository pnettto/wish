-- Follow-ups ("refine on preview", UX-PLAN §5.6).
-- awaiting_since: when the current automation round started waiting for a report
-- (issue creation, then each follow-up). Reports and runs older than this are ignored.
ALTER TABLE requests ADD COLUMN awaiting_since INTEGER;
ALTER TABLE requests ADD COLUMN followup_count INTEGER NOT NULL DEFAULT 0;
UPDATE requests SET awaiting_since = issue_created_at WHERE awaiting_since IS NULL;

CREATE TABLE followups (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  client_followup_id TEXT NOT NULL UNIQUE,
  comment_id INTEGER,                  -- NULL while the comment is being posted
  comment_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX followups_request ON followups(request_id, created_at);
