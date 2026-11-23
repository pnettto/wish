import { isTerminalState, parsePiReport, type RequestState } from "@web-issuer/shared";
import { verifyGitHubSignature } from "./crypto";
import type { Env } from "./env";
import { isTracked } from "./env";
import {
  findByIssue,
  findByRunId,
  matchRun,
  pendingRequests,
  scheduleFailure,
  updateRequest,
} from "./requests";

const REPORT_AUTHOR = "github-actions[bot]";
const WORKFLOW_NAME = "pi";
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);

interface Repo {
  full_name: string;
}

interface IssueCommentPayload {
  action: string;
  repository: Repo;
  issue: { number: number; pull_request?: unknown };
  comment: { body: string | null; user: { login: string } | null; created_at: string };
}

interface WorkflowRunPayload {
  action: string;
  repository: Repo;
  workflow_run: {
    id: number;
    name: string | null;
    event: string;
    status: string | null;
    conclusion: string | null;
    display_title: string;
    html_url: string;
    created_at: string;
    actor: { login: string } | null;
  };
}

interface WorkflowJobPayload {
  action: string;
  repository: Repo;
  workflow_job: {
    run_id: number;
    workflow_name: string | null;
    status: string;
    conclusion: string | null;
  };
}

const noContent = () => new Response(null, { status: 204 });

export async function handleWebhook(env: Env, request: Request): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const ok = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, raw, request.headers.get("X-Hub-Signature-256"));
  if (!ok) return new Response("invalid signature", { status: 401 });

  let payload: { repository?: Repo };
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const repo = payload.repository?.full_name;
  if (!repo || !isTracked(env, repo)) return noContent();

  switch (request.headers.get("X-GitHub-Event")) {
    case "issue_comment":
      await onIssueComment(env, payload as IssueCommentPayload);
      break;
    case "workflow_run":
      await onWorkflowRun(env, payload as WorkflowRunPayload);
      break;
    case "workflow_job":
      await onWorkflowJob(env, payload as WorkflowJobPayload);
      break;
    default:
      break;
  }
  return noContent();
}

async function onIssueComment(env: Env, p: IssueCommentPayload): Promise<void> {
  if (p.action !== "created" || p.issue.pull_request) return;
  if (p.comment.user?.login !== REPORT_AUTHOR) return;
  const report = parsePiReport(p.comment.body ?? "");
  if (!report) return;

  const row = await findByIssue(env, p.repository.full_name, p.issue.number);
  if (!row || row.dry_run || isTerminalState(row.state)) return;
  const commentAt = Date.parse(p.comment.created_at);
  if (row.issue_created_at !== null && !Number.isNaN(commentAt) && commentAt < row.issue_created_at) return;

  const message =
    report.outcome === "failed" && report.message !== "the run failed."
      ? report.message
      : report.summary ?? (report.previewFailed ? "Preview deploy failed." : null);
  await updateRequest(env, row, {
    state: report.outcome,
    pr_url: report.prUrl ?? row.pr_url,
    preview_url: report.previewUrl,
    run_url: report.runUrl ?? row.run_url,
    run_id: report.runId ?? row.run_id,
    message,
  });
}

function isOurRun(env: Env, run: WorkflowRunPayload["workflow_run"]): boolean {
  return (
    run.name === WORKFLOW_NAME &&
    run.event === "issues" &&
    run.actor?.login.toLowerCase() === env.ALLOWED_LOGIN.toLowerCase()
  );
}

async function onWorkflowRun(env: Env, p: WorkflowRunPayload): Promise<void> {
  const run = p.workflow_run;
  if (!isOurRun(env, run)) return;
  const repo = p.repository.full_name;

  let row = await findByRunId(env, repo, run.id);
  if (!row) {
    const pending = await pendingRequests(env, repo);
    row = matchRun(pending, { id: run.id, createdAt: Date.parse(run.created_at), displayTitle: run.display_title });
    if (!row) return;
  }
  if (isTerminalState(row.state)) return;

  const state: RequestState = row.state === "created" ? "started" : row.state;
  row = await updateRequest(env, row, { state, run_id: run.id, run_url: run.html_url });

  if (p.action === "completed" && run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion)) {
    // The report comment usually follows; only fail if it doesn't arrive.
    await scheduleFailure(env, { requestId: row.id, runId: run.id, runUrl: run.html_url, conclusion: run.conclusion });
  }
}

async function onWorkflowJob(env: Env, p: WorkflowJobPayload): Promise<void> {
  const job = p.workflow_job;
  if (job.workflow_name !== WORKFLOW_NAME) return;
  const row = await findByRunId(env, p.repository.full_name, job.run_id);
  if (!row || isTerminalState(row.state)) return;

  if (job.conclusion === "skipped") {
    // The pi job is skipped for runs that aren't /pi requests: not ours.
    await updateRequest(env, row, { state: "created", run_id: null, run_url: null });
    return;
  }
  if (job.status === "in_progress" && (row.state === "created" || row.state === "started")) {
    await updateRequest(env, row, { state: "running" });
  }
}
