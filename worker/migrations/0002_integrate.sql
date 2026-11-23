-- Integrate (merge) support and report bookkeeping.
ALTER TABLE requests ADD COLUMN report_at INTEGER;       -- unix ms when the **pi:** report was posted
ALTER TABLE requests ADD COLUMN merge_sha TEXT;          -- squash commit on the default branch
ALTER TABLE requests ADD COLUMN merged_at INTEGER;       -- unix ms
ALTER TABLE requests ADD COLUMN deploy_run_id INTEGER;
ALTER TABLE requests ADD COLUMN deploy_run_url TEXT;
CREATE INDEX requests_repo_merge_sha ON requests(repo, merge_sha);
