import {
  parsePiReport,
  formatFollowupBody,
  formatIssueBody,
  INTEGRATABLE_STATES,
  MERGED_STATES,
  prNumberFromUrl,
  REQUEST_STATES,
  type PiReport,
  type Annotation,
  type CreateFollowupRequest,
  type CreateIssueRequest,
  type RequestState,
  type RequestView,
} from "@wish/shared";
import { accessToken, type SessionRow } from "./auth";
import type { Env } from "./env";
import { isTracked } from "./env";
import {
  commentHasEyesReaction,
  createIssue,
  createIssueComment,
  getCommitDate,
  getPull,
  GitHubError,
  isValidRepo,
  issueHasEyesReaction,
  listIssueComments,
  listIssueRuns,
  listPushRunsForSha,
  squashMerge,
} from "./github";
import { HttpError } from "./http";

export const STALL_CHECK_AFTER_MS = 3 * 60 * 1000;
export const STALLED_AFTER_MS = 10 * 60 * 1000;
export const RUN_MATCH_WINDOW_MS = 2 * 60 * 1000;
/** Allow a little clock skew between issue creation and run creation. */
export const RUN_MATCH_SKEW_MS = 10 * 1000;
export const FAILURE_GRACE_MS = 2 * 60 * 1000;
/** After a merge, give up waiting for a production deploy run after this long. */
export const NO_DEPLOY_AFTER_MS = 5 * 60 * 1000;
/** Start reconciling a merge with the Actions API after this long. */
export const DEPLOY_CHECK_AFTER_MS = 2 * 60 * 1000;
/** Commits on the PR newer than the report (plus this skew) block integration. */
export const PR_CHANGED_SKEW_MS = 60 * 1000;

export const REPORT_AUTHOR = "github-actions[bot]";
export const PI_WORKFLOW = "pi";
export const DEPLOY_WORKFLOW = "deploy";

/** States in which a `**pi:**` report is still expected. */
const AWAITING_REPORT: readonly RequestState[] = ["created", "started", "running"];

export function isAwaitingReport(row: RequestRow): boolean {
  return !row.dry_run && AWAITING_REPORT.includes(row.state);
}

export interface RequestRow {
  id: string;
  client_request_id: string;
  github_login: string;
  repo: string;
  issue_number: number | null;
  issue_url: string | null;
  issue_created_at: number | null;
  title: string;
  page_url: string;
  dry_run: number;
  state: RequestState;
  run_id: number | null;
  run_url: string | null;
  pr_url: string | null;
  preview_url: string | null;
  message: string | null;
  created_at: number;
  updated_at: number;
  report_at: number | null;
  merge_sha: string | null;
  merged_at: number | null;
  deploy_run_id: number | null;
  deploy_run_url: string | null;
  /** Start of the current automation round (issue creation or latest follow-up). */
  awaiting_since: number | null;
  followup_count: number;
}

/** "Waiting since" for the current round; falls back for rows created before migration 0003. */
export function awaitingSince(row: Pick<RequestRow, "awaiting_since" | "issue_created_at">): number | null {
  return row.awaiting_since ?? row.issue_created_at;
}

export type RequestPatch = Partial<
  Pick<
    RequestRow,
    | "issue_number"
    | "issue_url"
    | "issue_created_at"
    | "state"
    | "run_id"
    | "run_url"
    | "pr_url"
    | "preview_url"
    | "message"
    | "report_at"
    | "merge_sha"
    | "merged_at"
    | "deploy_run_id"
    | "deploy_run_url"
    | "awaiting_since"
    | "followup_count"
  >
>;

export function toView(row: RequestRow, now = Date.now()): RequestView {
  const since = awaitingSince(row);
  const stalled = row.state === "created" && !row.dry_run && since !== null && now - since > STALLED_AFTER_MS;
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    repo: row.repo,
    title: row.title,
    pageUrl: row.page_url,
    dryRun: !!row.dry_run,
    state: row.state,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    runId: row.run_id,
    runUrl: row.run_url,
    prUrl: row.pr_url,
    previewUrl: row.preview_url,
    prNumber: prNumberFromUrl(row.pr_url),
    deployRunUrl: row.deploy_run_url,
    message: stalled && !row.message ? "Automation hasn't started" : row.message,
    stalled,
    actionsUrl: `https://github.com/${row.repo}/actions`,
    followupCount: row.followup_count ?? 0,
    awaitingSince: since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getRequest(env: Env, id: string): Promise<RequestRow | null> {
  return env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first<RequestRow>();
}

export function findByIssue(env: Env, repo: string, issueNumber: number): Promise<RequestRow | null> {
  return env.DB.prepare("SELECT * FROM requests WHERE repo = ? COLLATE NOCASE AND issue_number = ?")
    .bind(repo, issueNumber)
    .first<RequestRow>();
}

export function findByRunId(env: Env, repo: string, runId: number): Promise<RequestRow | null> {
  return env.DB.prepare("SELECT * FROM requests WHERE repo = ? COLLATE NOCASE AND run_id = ?")
    .bind(repo, runId)
    .first<RequestRow>();
}

/** Tracked requests still waiting for their run to be identified. */
export function findByMergeSha(env: Env, repo: string, sha: string): Promise<RequestRow | null> {
  return env.DB.prepare("SELECT * FROM requests WHERE repo = ? COLLATE NOCASE AND merge_sha = ?")
    .bind(repo, sha)
    .first<RequestRow>();
}

export async function pendingRequests(env: Env, repo: string): Promise<RequestRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM requests WHERE repo = ? COLLATE NOCASE AND dry_run = 0 AND run_id IS NULL
       AND state IN ('created', 'started', 'running') ORDER BY COALESCE(awaiting_since, issue_created_at)`,
  )
    .bind(repo)
    .all<RequestRow>();
  return results;
}

export interface RunCandidate {
  id: number;
  createdAt: number;
  displayTitle: string;
}

/**
 * Pick the request a `pi` run belongs to: created within 2 min after the
 * issue (or the latest follow-up comment); if several match, prefer the one
 * whose title equals the run's display_title, then the closest in time.
 */
export function matchRun(requests: RequestRow[], run: RunCandidate): RequestRow | null {
  const inWindow = requests.filter((r) => {
    const since = awaitingSince(r);
    if (since === null) return false;
    const delta = run.createdAt - since;
    return delta >= -RUN_MATCH_SKEW_MS && delta <= RUN_MATCH_WINDOW_MS;
  });
  if (inWindow.length <= 1) return inWindow[0] ?? null;
  const byTitle = inWindow.filter((r) => r.title === run.displayTitle);
  const pool = byTitle.length > 0 ? byTitle : inWindow;
  return pool.reduce((best, r) =>
    Math.abs(run.createdAt - (awaitingSince(r) ?? 0)) < Math.abs(run.createdAt - (awaitingSince(best) ?? 0)) ? r : best,
  );
}

function liveStub(env: Env, id: string): DurableObjectStub {
  return env.REQUEST_LIVE.get(env.REQUEST_LIVE.idFromName(id));
}

export async function broadcast(env: Env, row: RequestRow): Promise<void> {
  try {
    await liveStub(env, row.id).fetch("https://request-live/broadcast", {
      method: "POST",
      body: JSON.stringify({ type: "state", request: toView(row) }),
    });
  } catch (err) {
    console.error("broadcast failed", err);
  }
}

export interface PendingFailure {
  requestId: string;
  runId: number;
  runUrl: string;
  conclusion: string;
}

/** Ask the request's Durable Object to mark it failed if no report arrives in time. */
export async function scheduleFailure(env: Env, failure: PendingFailure): Promise<void> {
  await liveStub(env, failure.requestId).fetch("https://request-live/schedule-failure", {
    method: "POST",
    body: JSON.stringify({ ...failure, at: Date.now() + FAILURE_GRACE_MS }),
  });
}

export async function applyPendingFailure(env: Env, failure: PendingFailure): Promise<void> {
  const row = await getRequest(env, failure.requestId);
  if (!row || !isAwaitingReport(row)) return;
  // A follow-up since then unlinked the run: the timer belongs to an older round.
  if (row.run_id !== failure.runId) return;
  await updateRequest(env, row, {
    state: "failed",
    run_id: failure.runId,
    run_url: failure.runUrl,
    message: `The workflow run ended (${failure.conclusion}) without a report.`,
  });
}

/** Persist a change and push it to connected panels. No-op if nothing changed. */
export async function updateRequest(env: Env, row: RequestRow, patch: RequestPatch): Promise<RequestRow> {
  const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && row[k as keyof RequestRow] !== v);
  if (entries.length === 0) return row;
  if (patch.state && !REQUEST_STATES.includes(patch.state)) throw new Error(`bad state ${patch.state}`);
  const now = Math.max(Date.now(), row.updated_at);
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  await env.DB.prepare(`UPDATE requests SET ${sets}, updated_at = ? WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), now, row.id)
    .run();
  const next = { ...row, ...Object.fromEntries(entries), updated_at: now } as RequestRow;
  await broadcast(env, next);
  return next;
}

/**
 * Apply a `**pi:**` report to a request. Only the first report posted after
 * the current round started (issue creation or the latest follow-up) counts.
 */
export async function applyReport(env: Env, row: RequestRow, report: PiReport, postedAt: number): Promise<RequestRow> {
  if (row.dry_run || !AWAITING_REPORT.includes(row.state)) return row;
  const since = awaitingSince(row);
  if (since !== null && !Number.isNaN(postedAt) && postedAt < since) return row;
  const message =
    report.outcome === "failed" && report.message !== "the run failed."
      ? report.message
      : (report.summary ?? (report.previewFailed ? "Preview deploy failed." : null));
  return updateRequest(env, row, {
    state: report.outcome,
    pr_url: report.prUrl ?? row.pr_url,
    preview_url: report.previewUrl,
    run_url: report.runUrl ?? row.run_url,
    run_id: report.runId ?? row.run_id,
    report_at: Number.isNaN(postedAt) ? Date.now() : postedAt,
    message,
  });
}

export interface DeployRun {
  id: number;
  html_url: string;
  status: string | null;
  conclusion: string | null;
}

/** Track the production deploy run that followed a merge. */
export async function applyDeployRun(env: Env, row: RequestRow, run: DeployRun): Promise<RequestRow> {
  if (row.state !== "integrating") return row;
  const link = { deploy_run_id: run.id, deploy_run_url: run.html_url };
  if (run.status !== "completed") return updateRequest(env, row, link);
  switch (run.conclusion) {
    case "success":
      return updateRequest(env, row, { ...link, state: "live", message: null });
    case "skipped":
    case "neutral":
      return updateRequest(env, row, { ...link, state: "merged", message: "Merged. The production deploy was skipped." });
    default:
      return updateRequest(env, row, {
        ...link,
        state: "deploy_failed",
        message: `Merged, but the production deploy ended: ${run.conclusion ?? "unknown"}.`,
      });
  }
}

// ---------------------------------------------------------------------------
// POST /issues

const MAX_ANNOTATIONS = 50;

function str(value: unknown, max: number, field: string, required = true): string {
  if (typeof value !== "string" || (required && value.trim() === "")) throw new HttpError(400, "invalid_request", `${field} is required`);
  if (value.length > max) throw new HttpError(400, "invalid_request", `${field} is too long`);
  return value;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseAnnotation(raw: unknown, i: number): Annotation {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "invalid_request", `annotation ${i + 1} is invalid`);
  const a = raw as Record<string, unknown>;
  const rect = (a.rect ?? {}) as Record<string, unknown>;
  const viewport = (a.viewport ?? {}) as Record<string, unknown>;
  const scroll = (a.scroll ?? {}) as Record<string, unknown>;
  return {
    id: str(a.id ?? String(i), 100, "annotation id"),
    comment: str(a.comment, 5000, `comment ${i + 1}`),
    locator: str(a.locator ?? "", 1000, "locator", false),
    tag: str(a.tag ?? "", 50, "tag", false),
    role: typeof a.role === "string" ? a.role.slice(0, 50) : null,
    kind: str(a.kind ?? "", 50, "kind", false),
    text: str(a.text ?? "", 200, "text", false),
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    viewport: { width: num(viewport.width), height: num(viewport.height) },
    scroll: { x: num(scroll.x), y: num(scroll.y) },
  };
}

export function parseCreateIssue(body: unknown): CreateIssueRequest {
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_request", "JSON body required");
  const b = body as Record<string, unknown>;
  const clientRequestId = str(b.clientRequestId, 100, "clientRequestId");
  const repo = str(b.repo, 200, "repo");
  if (!isValidRepo(repo)) throw new HttpError(400, "invalid_request", "repo must be owner/name");
  const pageUrl = str(b.pageUrl, 4000, "pageUrl");
  if (!/^https?:\/\//i.test(pageUrl)) throw new HttpError(400, "invalid_request", "pageUrl must be http(s)");
  if (!Array.isArray(b.annotations) || b.annotations.length === 0) {
    throw new HttpError(400, "invalid_request", "at least one comment is required");
  }
  if (b.annotations.length > MAX_ANNOTATIONS) throw new HttpError(400, "invalid_request", "too many comments");
  return {
    clientRequestId,
    repo,
    title: str(b.title, 256, "title").trim(),
    pageUrl,
    pageTitle: typeof b.pageTitle === "string" ? b.pageTitle.slice(0, 300) : undefined,
    annotations: b.annotations.map(parseAnnotation),
    dryRun: b.dryRun === true,
  };
}

function getByClientId(env: Env, clientRequestId: string): Promise<RequestRow | null> {
  return env.DB.prepare("SELECT * FROM requests WHERE client_request_id = ?").bind(clientRequestId).first<RequestRow>();
}

export async function handleCreateIssue(env: Env, session: SessionRow, body: unknown): Promise<RequestView> {
  const input = parseCreateIssue(body);

  const existing = await getByClientId(env, input.clientRequestId);
  if (existing) return existingOrConflict(existing, session);

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO requests (id, client_request_id, github_login, repo, title, page_url, dry_run, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
    )
      .bind(id, input.clientRequestId, session.github_login, input.repo, input.title, input.pageUrl, input.dryRun ? 1 : 0, now, now)
      .run();
  } catch {
    // Lost a race with a concurrent submit of the same draft.
    const raced = await getByClientId(env, input.clientRequestId);
    if (raced) return existingOrConflict(raced, session);
    throw new HttpError(500, "db_error");
  }

  let issue;
  try {
    const token = await accessToken(env, session);
    const body = formatIssueBody({
      requestId: id,
      pageUrl: input.pageUrl,
      pageTitle: input.pageTitle,
      annotations: input.annotations,
      dryRun: input.dryRun,
    });
    issue = await createIssue(token, input.repo, input.title, body);
  } catch (err) {
    // Nothing was created (or we can't tell): free the client id so a retry works.
    await env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(id).run();
    if (err instanceof HttpError) throw err;
    if (err instanceof GitHubError) {
      throw new HttpError(err.status === 401 ? 401 : 502, err.status === 401 ? "github_reauth" : "github_error", err.message);
    }
    throw err;
  }

  const state: RequestState = input.dryRun || !isTracked(env, input.repo) ? "untracked" : "created";
  const createdAt = Date.parse(issue.created_at);
  const issueCreatedAt = Number.isNaN(createdAt) ? Date.now() : createdAt;
  await env.DB.prepare(
    "UPDATE requests SET issue_number = ?, issue_url = ?, issue_created_at = ?, awaiting_since = ?, state = ?, updated_at = ? WHERE id = ?",
  )
    .bind(issue.number, issue.html_url, issueCreatedAt, issueCreatedAt, state, Date.now(), id)
    .run();
  const row = await getRequest(env, id);
  if (!row) throw new HttpError(500, "db_error");
  return toView(row);
}

function existingOrConflict(row: RequestRow, session: SessionRow): RequestView {
  if (row.github_login !== session.github_login) throw new HttpError(409, "conflict", "clientRequestId already used");
  if (row.state === "creating") throw new HttpError(409, "in_progress", "This issue is already being created");
  return toView(row);
}

// ---------------------------------------------------------------------------
// GET /requests/:id (+ safety net for missed webhooks)

const lastCheck = new Map<string, number>();
const CHECK_INTERVAL_MS = 30 * 1000;

export async function loadOwnedRequest(env: Env, session: SessionRow, id: string): Promise<RequestRow> {
  const row = await getRequest(env, id);
  if (!row || row.github_login !== session.github_login) throw new HttpError(404, "not_found");
  return row;
}

export async function handleGetRequest(env: Env, session: SessionRow, id: string): Promise<RequestView> {
  let row = await loadOwnedRequest(env, session, id);
  const check = safetyCheck(row);
  if (check) {
    try {
      row = await check(env, session, row);
    } catch (err) {
      console.error("safety check failed", err);
    }
  }
  return toView(row);
}

/** Test hook: forget throttling state. */
export function resetSafetyThrottle(): void {
  lastCheck.clear();
}

type Check = (env: Env, session: SessionRow, row: RequestRow) => Promise<RequestRow>;

function safetyCheck(row: RequestRow): Check | null {
  const now = Date.now();
  let check: Check | null = null;
  const since = awaitingSince(row);
  if (!row.dry_run && AWAITING_REPORT.includes(row.state) && since !== null && row.issue_number !== null) {
    if (now - since >= STALL_CHECK_AFTER_MS) check = checkAutomation;
  } else if (row.state === "integrating" && row.merge_sha && row.merged_at !== null) {
    if (now - row.merged_at >= DEPLOY_CHECK_AFTER_MS) check = checkDeploy;
  }
  if (!check) return null;
  const last = lastCheck.get(row.id) ?? 0;
  if (now - last < CHECK_INTERVAL_MS) return null;
  lastCheck.set(row.id, now);
  return check;
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Look for a missed report comment, then for a missed run start. */
const checkAutomation: Check = async (env, session, row) => {
  const token = await accessToken(env, session);
  const sinceMs = awaitingSince(row) ?? 0;
  const comments = await listIssueComments(token, row.repo, row.issue_number!, isoSeconds(sinceMs));
  for (const c of comments) {
    if (c.user?.login !== REPORT_AUTHOR) continue;
    // `since` filters on updated_at; skip reports from an earlier round.
    if (Date.parse(c.created_at) < sinceMs) continue;
    const report = parsePiReport(c.body ?? "");
    if (report) return applyReport(env, row, report, Date.parse(c.created_at));
  }
  if (row.state !== "created") return row;

  const followup = row.followup_count > 0 ? await latestFollowup(env, row.id) : null;
  const event = followup ? "issue_comment" : "issues";
  const runs = await listIssueRuns(token, row.repo, isoSeconds(sinceMs - RUN_MATCH_SKEW_MS), event);
  const pending = await pendingRequests(env, row.repo);
  for (const run of runs) {
    if (run.name !== PI_WORKFLOW || run.actor?.login.toLowerCase() !== env.ALLOWED_LOGIN.toLowerCase()) continue;
    const match = matchRun(pending, { id: run.id, createdAt: Date.parse(run.created_at), displayTitle: run.display_title });
    if (match?.id === row.id) {
      return updateRequest(env, row, { state: "started", run_id: run.id, run_url: run.html_url });
    }
  }
  const acknowledged = followup
    ? followup.comment_id !== null && (await commentHasEyesReaction(token, row.repo, followup.comment_id))
    : row.issue_number !== null && (await issueHasEyesReaction(token, row.repo, row.issue_number));
  if (acknowledged) return updateRequest(env, row, { state: "started" });
  return row;
};

/** Find the production deploy for a merge; give up if none appears. */
const checkDeploy: Check = async (env, session, row) => {
  const token = await accessToken(env, session);
  const runs = await listPushRunsForSha(token, row.repo, row.merge_sha!);
  const deploy = runs.find((r) => r.name === DEPLOY_WORKFLOW);
  if (deploy) return applyDeployRun(env, row, deploy);
  if (Date.now() - (row.merged_at ?? 0) >= NO_DEPLOY_AFTER_MS) {
    return updateRequest(env, row, { state: "merged", message: "Merged. No production deploy was triggered." });
  }
  return row;
};

// ---------------------------------------------------------------------------
// POST /requests/:id/integrate

function prBelongsToRepo(prUrl: string, repo: string): boolean {
  return prUrl.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`);
}

/** Squash-merge the request's PR so the repo's production deploy runs. */
export async function handleIntegrate(env: Env, session: SessionRow, id: string): Promise<RequestView> {
  const row = await loadOwnedRequest(env, session, id);
  if (MERGED_STATES.includes(row.state)) return toView(row);
  if (!INTEGRATABLE_STATES.includes(row.state)) throw new HttpError(409, "not_ready", "There are no changes to integrate yet.");
  const prNumber = prNumberFromUrl(row.pr_url);
  if (row.dry_run || !row.pr_url || !prNumber || !prBelongsToRepo(row.pr_url, row.repo)) {
    throw new HttpError(409, "no_pr", "This request has no pull request to integrate.");
  }

  const token = await accessToken(env, session);
  const pr = await getPull(token, row.repo, prNumber);
  const merged = (sha: string | null) =>
    updateRequest(env, row, { state: "integrating", merge_sha: sha, merged_at: Date.now(), message: null }).then((r) => toView(r));

  if (pr.merged) return merged(pr.merge_commit_sha);
  if (pr.state !== "open") throw new HttpError(409, "pr_closed", `PR #${prNumber} is closed.`);

  // Don't ship commits that landed after the preview was built.
  if (row.report_at !== null) {
    const headDate = await getCommitDate(token, row.repo, pr.head.sha);
    if (!Number.isNaN(headDate) && headDate > row.report_at + PR_CHANGED_SKEW_MS) {
      throw new HttpError(409, "pr_changed", `PR #${prNumber} changed after the preview was built. Review it on GitHub first.`);
    }
  }

  try {
    const result = await squashMerge(token, row.repo, prNumber, pr.head.sha, pr.title);
    return await merged(result.sha);
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    if (err.status === 403 || err.status === 404) {
      throw new HttpError(403, "missing_permission", "The GitHub App can't merge. Give it Contents and Pull requests: Read and write.");
    }
    if (err.status === 405 || err.status === 409 || err.status === 422) {
      throw new HttpError(409, "merge_refused", `GitHub refused the merge: ${err.message}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /requests/:id/followups

export interface FollowupRow {
  id: string;
  request_id: string;
  client_followup_id: string;
  comment_id: number | null;
  comment_url: string | null;
  created_at: number;
}

function latestFollowup(env: Env, requestId: string): Promise<FollowupRow | null> {
  return env.DB.prepare("SELECT * FROM followups WHERE request_id = ? AND comment_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    .bind(requestId)
    .first<FollowupRow>();
}

function getFollowupByClientId(env: Env, clientFollowupId: string): Promise<FollowupRow | null> {
  return env.DB.prepare("SELECT * FROM followups WHERE client_followup_id = ?").bind(clientFollowupId).first<FollowupRow>();
}

export function parseCreateFollowup(body: unknown): CreateFollowupRequest {
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_request", "JSON body required");
  const b = body as Record<string, unknown>;
  const clientFollowupId = str(b.clientFollowupId, 100, "clientFollowupId");
  const pageUrl = str(b.pageUrl, 4000, "pageUrl");
  if (!/^https?:\/\//i.test(pageUrl)) throw new HttpError(400, "invalid_request", "pageUrl must be http(s)");
  if (!Array.isArray(b.annotations) || b.annotations.length === 0) {
    throw new HttpError(400, "invalid_request", "at least one comment is required");
  }
  if (b.annotations.length > MAX_ANNOTATIONS) throw new HttpError(400, "invalid_request", "too many comments");
  return {
    clientFollowupId,
    pageUrl,
    pageTitle: typeof b.pageTitle === "string" ? b.pageTitle.slice(0, 300) : undefined,
    annotations: b.annotations.map(parseAnnotation),
  };
}

/**
 * Post a `/pi` follow-up comment on the request's issue. pi continues the same
 * session on the same branch, so the PR and preview URL stay the same.
 */
export async function handleFollowup(env: Env, session: SessionRow, id: string, body: unknown): Promise<RequestView> {
  const input = parseCreateFollowup(body);
  const row = await loadOwnedRequest(env, session, id);

  const existing = await getFollowupByClientId(env, input.clientFollowupId);
  if (existing) {
    if (existing.request_id !== row.id) throw new HttpError(409, "conflict", "clientFollowupId already used");
    if (existing.comment_id === null) throw new HttpError(409, "in_progress", "This follow-up is already being posted");
    return toView(row);
  }

  if (row.dry_run) throw new HttpError(409, "dry_run", "Dry runs have no automation to refine. File a new request instead.");
  if (MERGED_STATES.includes(row.state)) throw new HttpError(409, "merged", "This request was already merged. File a new request instead.");
  if (row.state === "creating" || AWAITING_REPORT.includes(row.state)) {
    throw new HttpError(409, "in_progress", "The automation is still running. Wait for it to finish first.");
  }
  if (row.state === "untracked" || row.issue_number === null) {
    throw new HttpError(409, "untracked", "Progress isn't tracked for this repository, so it can't be refined here.");
  }

  const followupId = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare("INSERT INTO followups (id, request_id, client_followup_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(followupId, row.id, input.clientFollowupId, now)
      .run();
  } catch {
    const raced = await getFollowupByClientId(env, input.clientFollowupId);
    if (raced) throw new HttpError(409, "in_progress", "This follow-up is already being posted");
    throw new HttpError(500, "db_error");
  }

  let comment;
  try {
    const token = await accessToken(env, session);
    const text = formatFollowupBody({
      followupId,
      pageUrl: input.pageUrl,
      pageTitle: input.pageTitle,
      annotations: input.annotations,
    });
    comment = await createIssueComment(token, row.repo, row.issue_number, text);
  } catch (err) {
    await env.DB.prepare("DELETE FROM followups WHERE id = ?").bind(followupId).run();
    if (err instanceof HttpError) throw err;
    if (err instanceof GitHubError) {
      throw new HttpError(err.status === 401 ? 401 : 502, err.status === 401 ? "github_reauth" : "github_error", err.message);
    }
    throw err;
  }

  const postedAt = Date.parse(comment.created_at);
  const since = Number.isNaN(postedAt) ? Date.now() : postedAt;
  await env.DB.prepare("UPDATE followups SET comment_id = ?, comment_url = ?, created_at = ? WHERE id = ?")
    .bind(comment.id, comment.html_url, since, followupId)
    .run();
  // Keep pr_url/preview_url: the branch (and so the preview) stays the same.
  const next = await updateRequest(env, row, {
    state: "created",
    awaiting_since: since,
    followup_count: row.followup_count + 1,
    run_id: null,
    run_url: null,
    message: null,
  });
  return toView(next);
}
