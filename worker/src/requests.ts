import {
  formatIssueBody,
  isTerminalState,
  REQUEST_STATES,
  type Annotation,
  type CreateIssueRequest,
  type RequestState,
  type RequestView,
} from "@web-issuer/shared";
import { accessToken, type SessionRow } from "./auth";
import type { Env } from "./env";
import { isTracked } from "./env";
import { createIssue, GitHubError, isValidRepo, issueHasEyesReaction, listIssueRuns } from "./github";
import { HttpError } from "./http";

export const STALL_CHECK_AFTER_MS = 3 * 60 * 1000;
export const STALLED_AFTER_MS = 10 * 60 * 1000;
export const RUN_MATCH_WINDOW_MS = 2 * 60 * 1000;
/** Allow a little clock skew between issue creation and run creation. */
export const RUN_MATCH_SKEW_MS = 10 * 1000;
export const FAILURE_GRACE_MS = 2 * 60 * 1000;

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
}

export type RequestPatch = Partial<
  Pick<
    RequestRow,
    "issue_number" | "issue_url" | "issue_created_at" | "state" | "run_id" | "run_url" | "pr_url" | "preview_url" | "message"
  >
>;

export function toView(row: RequestRow, now = Date.now()): RequestView {
  const stalled =
    row.state === "created" &&
    !row.dry_run &&
    row.issue_created_at !== null &&
    now - row.issue_created_at > STALLED_AFTER_MS;
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
    message: stalled && !row.message ? "Automation hasn't started" : row.message,
    stalled,
    actionsUrl: `https://github.com/${row.repo}/actions`,
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
export async function pendingRequests(env: Env, repo: string): Promise<RequestRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM requests WHERE repo = ? COLLATE NOCASE AND dry_run = 0 AND run_id IS NULL
       AND state IN ('created', 'started', 'running') ORDER BY issue_created_at`,
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
 * issue; if several match, prefer the one whose title equals the run's
 * display_title, then the closest in time.
 */
export function matchRun(requests: RequestRow[], run: RunCandidate): RequestRow | null {
  const inWindow = requests.filter((r) => {
    if (r.issue_created_at === null) return false;
    const delta = run.createdAt - r.issue_created_at;
    return delta >= -RUN_MATCH_SKEW_MS && delta <= RUN_MATCH_WINDOW_MS;
  });
  if (inWindow.length <= 1) return inWindow[0] ?? null;
  const byTitle = inWindow.filter((r) => r.title === run.displayTitle);
  const pool = byTitle.length > 0 ? byTitle : inWindow;
  return pool.reduce((best, r) =>
    Math.abs(run.createdAt - (r.issue_created_at ?? 0)) < Math.abs(run.createdAt - (best.issue_created_at ?? 0)) ? r : best,
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
  if (!row || isTerminalState(row.state)) return;
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
    "UPDATE requests SET issue_number = ?, issue_url = ?, issue_created_at = ?, state = ?, updated_at = ? WHERE id = ?",
  )
    .bind(issue.number, issue.html_url, issueCreatedAt, state, Date.now(), id)
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
// GET /requests/:id (+ safety net)

const lastStallCheck = new Map<string, number>();
const STALL_CHECK_INTERVAL_MS = 30 * 1000;

export async function loadOwnedRequest(env: Env, session: SessionRow, id: string): Promise<RequestRow> {
  const row = await getRequest(env, id);
  if (!row || row.github_login !== session.github_login) throw new HttpError(404, "not_found");
  return row;
}

export async function handleGetRequest(env: Env, session: SessionRow, id: string): Promise<RequestView> {
  let row = await loadOwnedRequest(env, session, id);
  if (shouldCheckStall(row)) {
    try {
      row = await checkStalled(env, session, row);
    } catch (err) {
      console.error("stall check failed", err);
    }
  }
  return toView(row);
}

function shouldCheckStall(row: RequestRow): boolean {
  if (row.state !== "created" || row.dry_run || row.issue_created_at === null || row.issue_number === null) return false;
  const now = Date.now();
  if (now - row.issue_created_at < STALL_CHECK_AFTER_MS) return false;
  const last = lastStallCheck.get(row.id) ?? 0;
  if (now - last < STALL_CHECK_INTERVAL_MS) return false;
  lastStallCheck.set(row.id, now);
  return true;
}

/** Webhooks may have been missed: look for the 👀 reaction and a matching run. */
async function checkStalled(env: Env, session: SessionRow, row: RequestRow): Promise<RequestRow> {
  const token = await accessToken(env, session);
  const since = new Date((row.issue_created_at ?? 0) - RUN_MATCH_SKEW_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const runs = await listIssueRuns(token, row.repo, since);
  const pending = await pendingRequests(env, row.repo);
  for (const run of runs) {
    if (run.name !== "pi" || run.actor?.login.toLowerCase() !== env.ALLOWED_LOGIN.toLowerCase()) continue;
    const match = matchRun(pending, { id: run.id, createdAt: Date.parse(run.created_at), displayTitle: run.display_title });
    if (match?.id === row.id) {
      return updateRequest(env, row, { state: "started", run_id: run.id, run_url: run.html_url });
    }
  }
  if (row.issue_number !== null && (await issueHasEyesReaction(token, row.repo, row.issue_number))) {
    return updateRequest(env, row, { state: "started" });
  }
  return row;
}
