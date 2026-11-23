import type { Env } from "./env";
import { publicUrl } from "./env";

const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.includes("..");
}

function repoPath(repo: string): string {
  if (!isValidRepo(repo)) throw new GitHubError(400, `invalid repo: ${repo}`);
  const [owner, name] = repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

async function gh<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "web-issuer",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { message?: string };
      if (data.message) message = data.message;
    } catch {
      // Not JSON; keep the status line.
    }
    throw new GitHubError(res.status, message);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

export interface TokenSet {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

/** Tokens without expiry (app setting off) are treated as valid for a year. */
const NO_EXPIRY_MS = 365 * 24 * 3600 * 1000;

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "web-issuer" },
    body: JSON.stringify(params),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new GitHubError(res.ok ? 401 : res.status, data.error_description ?? data.error ?? "token exchange failed");
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    accessExpiresAt: now + (data.expires_in ? data.expires_in * 1000 : NO_EXPIRY_MS),
    refreshToken: data.refresh_token ?? "",
    refreshExpiresAt: data.refresh_token ? now + (data.refresh_token_expires_in ?? 0) * 1000 : 0,
  };
}

export function exchangeCode(env: Env, code: string): Promise<TokenSet> {
  return tokenRequest({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: `${publicUrl(env)}/auth/callback`,
  });
}

export function refreshAccessToken(env: Env, refreshToken: string): Promise<TokenSet> {
  return tokenRequest({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function getUser(token: string): Promise<{ login: string }> {
  return gh<{ login: string }>(token, "GET", "/user");
}

export interface CreatedIssue {
  number: number;
  html_url: string;
  created_at: string;
}

export function createIssue(token: string, repo: string, title: string, body: string): Promise<CreatedIssue> {
  return gh<CreatedIssue>(token, "POST", `${repoPath(repo)}/issues`, { title, body });
}

/** Repositories the user can reach through the app's installations. */
export async function listInstalledRepos(token: string): Promise<string[]> {
  const { installations } = await gh<{ installations: { id: number }[] }>(token, "GET", "/user/installations?per_page=100");
  const repos = new Set<string>();
  for (const inst of installations) {
    for (let page = 1; page <= 10; page++) {
      const data = await gh<{ repositories: { full_name: string }[]; total_count: number }>(
        token,
        "GET",
        `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
      );
      for (const r of data.repositories) repos.add(r.full_name);
      if (data.repositories.length < 100) break;
    }
  }
  return [...repos].sort((a, b) => a.localeCompare(b));
}

export interface CreatedComment {
  id: number;
  html_url: string;
  created_at: string;
}

export function createIssueComment(token: string, repo: string, issue: number, body: string): Promise<CreatedComment> {
  return gh<CreatedComment>(token, "POST", `${repoPath(repo)}/issues/${issue}/comments`, { body });
}

/** pi acknowledges a follow-up with 👀 on the comment (not the issue). */
export async function commentHasEyesReaction(token: string, repo: string, commentId: number): Promise<boolean> {
  const reactions = await gh<{ content: string }[]>(
    token,
    "GET",
    `${repoPath(repo)}/issues/comments/${commentId}/reactions?content=eyes&per_page=100`,
  );
  return reactions.length > 0;
}

export async function issueHasEyesReaction(token: string, repo: string, issue: number): Promise<boolean> {
  const reactions = await gh<{ content: string; user: { login: string } | null }[]>(
    token,
    "GET",
    `${repoPath(repo)}/issues/${issue}/reactions?content=eyes&per_page=100`,
  );
  return reactions.length > 0;
}

export interface WorkflowRunSummary {
  id: number;
  name: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  display_title: string;
  html_url: string;
  created_at: string;
  actor: { login: string } | null;
}

export async function listIssueRuns(
  token: string,
  repo: string,
  sinceIso: string,
  event: "issues" | "issue_comment" = "issues",
): Promise<WorkflowRunSummary[]> {
  const q = new URLSearchParams({ event, created: `>=${sinceIso}`, per_page: "30" });
  const data = await gh<{ workflow_runs: WorkflowRunSummary[] }>(token, "GET", `${repoPath(repo)}/actions/runs?${q}`);
  return data.workflow_runs;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  title: string;
  head: { sha: string; ref: string };
}

export function getPull(token: string, repo: string, number: number): Promise<PullRequest> {
  return gh<PullRequest>(token, "GET", `${repoPath(repo)}/pulls/${number}`);
}

/** Committer date of a commit (unix ms). */
export async function getCommitDate(token: string, repo: string, sha: string): Promise<number> {
  const data = await gh<{ commit: { committer: { date: string } | null; author: { date: string } | null } }>(
    token,
    "GET",
    `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`,
  );
  return Date.parse(data.commit.committer?.date ?? data.commit.author?.date ?? "");
}

/** Squash-merge, pinned to `sha` so GitHub refuses if the branch moved. */
export function squashMerge(
  token: string,
  repo: string,
  number: number,
  sha: string,
  title: string,
): Promise<{ merged: boolean; sha: string; message: string }> {
  return gh(token, "PUT", `${repoPath(repo)}/pulls/${number}/merge`, {
    merge_method: "squash",
    sha,
    commit_title: `${title} (#${number})`,
  });
}

export interface IssueComment {
  id: number;
  body: string | null;
  created_at: string;
  user: { login: string } | null;
}

export function listIssueComments(token: string, repo: string, issue: number, sinceIso: string): Promise<IssueComment[]> {
  const q = new URLSearchParams({ since: sinceIso, per_page: "100" });
  return gh<IssueComment[]>(token, "GET", `${repoPath(repo)}/issues/${issue}/comments?${q}`);
}

export async function listPushRunsForSha(token: string, repo: string, sha: string): Promise<WorkflowRunSummary[]> {
  const q = new URLSearchParams({ event: "push", head_sha: sha, per_page: "30" });
  const data = await gh<{ workflow_runs: WorkflowRunSummary[] }>(token, "GET", `${repoPath(repo)}/actions/runs?${q}`);
  return data.workflow_runs;
}
