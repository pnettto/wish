import type { RequestView } from "@web-issuer/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import { applyPendingFailure, getRequest } from "../src/requests";
import { createSession, fixture, ISSUE_CREATED_AT, makeEnv, seedRequest, webhookRequest } from "./helpers";

let ctx: ReturnType<typeof makeEnv>;
let fetchMock: ReturnType<typeof vi.fn>;
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;

const BASE = "https://issuer.pnetto.store";
const GH = "https://api.github.com/repos/pnettto/hawk";
const REPORT_AT = Date.parse("2026-11-23T10:05:00Z");
const MERGE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  ctx = makeEnv();
  routes = {};
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(REPORT_AT + 60_000);
  fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const key = `${init.method ?? "GET"} ${url.origin}${url.pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function call(path: string, token: string, method = "GET") {
  return handle(new Request(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}` } }), ctx.env);
}

const succeeded = () =>
  seedRequest(ctx.env, {
    state: "succeeded",
    run_id: 1234567890,
    run_url: "https://github.com/pnettto/hawk/actions/runs/1234567890",
    pr_url: "https://github.com/pnettto/hawk/pull/143",
    preview_url: "https://hawk-pi-issue-142.example.workers.dev",
    report_at: REPORT_AT,
  });

function mockOpenPr(commitDate = "2026-11-23T10:04:30Z") {
  routes[`GET ${GH}/pulls/143`] = () =>
    jsonRes({ number: 143, state: "open", merged: false, merge_commit_sha: null, mergeable: true, title: "pi: Improve the pricing page", head: { sha: HEAD_SHA, ref: "pi/issue-142" } });
  routes[`GET ${GH}/commits/${HEAD_SHA}`] = () => jsonRes({ commit: { committer: { date: commitDate }, author: { date: commitDate } } });
}

function deployRun(action: string, status: string, conclusion: string | null) {
  return JSON.stringify({
    action,
    workflow_run: {
      id: 555,
      name: "deploy",
      event: "push",
      status,
      conclusion,
      display_title: "pi: Improve the pricing page (#143)",
      html_url: "https://github.com/pnettto/hawk/actions/runs/555",
      created_at: "2026-11-23T10:06:05Z",
      head_branch: "main",
      head_sha: MERGE_SHA,
      actor: { login: "pnettto" },
    },
    repository: { full_name: "pnettto/hawk" },
  });
}

async function sendWebhook(event: string, body: string) {
  expect((await handle(await webhookRequest(event, body), ctx.env)).status).toBe(204);
}

describe("POST /requests/:id/integrate", () => {
  it("squash-merges pinned to the PR head, then tracks the deploy to live", async () => {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    mockOpenPr();
    let mergeBody: Record<string, unknown> = {};
    routes[`PUT ${GH}/pulls/143/merge`] = (_url, init) => {
      mergeBody = JSON.parse(String(init.body));
      return jsonRes({ merged: true, sha: MERGE_SHA, message: "Pull Request successfully merged" });
    };

    const res = await call(`/requests/${row.id}/integrate`, token, "POST");
    expect(res.status).toBe(200);
    const view = (await res.json()) as RequestView;
    expect(view).toMatchObject({ state: "integrating", prNumber: 143, deployRunUrl: null });
    expect(mergeBody).toEqual({ merge_method: "squash", sha: HEAD_SHA, commit_title: "pi: Improve the pricing page (#143)" });
    expect(await getRequest(ctx.env, row.id)).toMatchObject({ merge_sha: MERGE_SHA });

    // Clicking again is harmless: no second merge.
    expect(((await (await call(`/requests/${row.id}/integrate`, token, "POST")).json()) as RequestView).state).toBe("integrating");
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith("/merge") && (i as RequestInit).method === "PUT")).toHaveLength(1);

    await sendWebhook("workflow_run", deployRun("in_progress", "in_progress", null));
    expect(await getRequest(ctx.env, row.id)).toMatchObject({ state: "integrating", deploy_run_url: "https://github.com/pnettto/hawk/actions/runs/555" });

    await sendWebhook("workflow_run", deployRun("completed", "completed", "success"));
    expect((await getRequest(ctx.env, row.id))?.state).toBe("live");
  });

  it("marks a failed production deploy", async () => {
    await seedRequest(ctx.env, { state: "integrating", merge_sha: MERGE_SHA, merged_at: REPORT_AT, pr_url: "https://github.com/pnettto/hawk/pull/143" });
    await sendWebhook("workflow_run", deployRun("completed", "completed", "failure"));
    const row = await ctx.env.DB.prepare("SELECT * FROM requests").first<{ state: string; message: string }>();
    expect(row).toMatchObject({ state: "deploy_failed", message: "Merged, but the production deploy ended: failure." });
  });

  it("ignores deploy runs for other commits", async () => {
    const row = await seedRequest(ctx.env, { state: "integrating", merge_sha: "c".repeat(40), merged_at: REPORT_AT });
    await sendWebhook("workflow_run", deployRun("completed", "completed", "success"));
    expect((await getRequest(ctx.env, row.id))?.state).toBe("integrating");
  });

  it("accepts an already merged PR", async () => {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    routes[`GET ${GH}/pulls/143`] = () =>
      jsonRes({ number: 143, state: "closed", merged: true, merge_commit_sha: MERGE_SHA, mergeable: null, title: "t", head: { sha: HEAD_SHA, ref: "x" } });
    expect(((await (await call(`/requests/${row.id}/integrate`, token, "POST")).json()) as RequestView).state).toBe("integrating");
    expect((await getRequest(ctx.env, row.id))?.merge_sha).toBe(MERGE_SHA);
  });

  it("refuses when the PR changed after the preview", async () => {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    mockOpenPr("2026-11-23T10:30:00Z");
    const res = await call(`/requests/${row.id}/integrate`, token, "POST");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "pr_changed" });
    expect((await getRequest(ctx.env, row.id))?.state).toBe("succeeded");
  });

  it("allows checks_failed (the panel confirms first)", async () => {
    const token = await createSession(ctx.env);
    const row = await seedRequest(ctx.env, { state: "checks_failed", pr_url: "https://github.com/pnettto/hawk/pull/143", report_at: REPORT_AT });
    mockOpenPr();
    routes[`PUT ${GH}/pulls/143/merge`] = () => jsonRes({ merged: true, sha: MERGE_SHA, message: "ok" });
    expect((await call(`/requests/${row.id}/integrate`, token, "POST")).status).toBe(200);
  });

  it.each([
    [405, "merge_refused", 409],
    [409, "merge_refused", 409],
    [403, "missing_permission", 403],
  ])("maps GitHub %i to %s", async (ghStatus, code, status) => {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    mockOpenPr();
    routes[`PUT ${GH}/pulls/143/merge`] = () => jsonRes({ message: "Pull Request is not mergeable" }, ghStatus);
    const res = await call(`/requests/${row.id}/integrate`, token, "POST");
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: code });
    expect((await getRequest(ctx.env, row.id))?.state).toBe("succeeded");
  });

  it("rejects requests without changes, dry runs and foreign PR links", async () => {
    const token = await createSession(ctx.env);
    const running = await seedRequest(ctx.env, { state: "running" });
    const noChanges = await seedRequest(ctx.env, { state: "no_changes", client_request_id: "b", issue_number: 2 });
    const foreign = await seedRequest(ctx.env, { state: "succeeded", client_request_id: "c", issue_number: 3, pr_url: "https://github.com/evil/repo/pull/1" });
    expect((await call(`/requests/${running.id}/integrate`, token, "POST")).status).toBe(409);
    expect((await call(`/requests/${noChanges.id}/integrate`, token, "POST")).status).toBe(409);
    expect((await call(`/requests/${foreign.id}/integrate`, token, "POST")).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a late pi failure timer doesn't override integration", async () => {
    const row = await seedRequest(ctx.env, { state: "integrating", merge_sha: MERGE_SHA, merged_at: REPORT_AT });
    await applyPendingFailure(ctx.env, { requestId: row.id, runId: 1, runUrl: "https://x", conclusion: "failure" });
    expect((await getRequest(ctx.env, row.id))?.state).toBe("integrating");
  });
});

describe("safety net", () => {
  it("records report_at from the report webhook", async () => {
    const row = await seedRequest(ctx.env, { state: "running", run_id: 1234567890 });
    await sendWebhook("issue_comment", fixture("issue_comment.created"));
    expect((await getRequest(ctx.env, row.id))?.report_at).toBe(Date.parse("2026-11-23T10:05:00Z"));
  });

  it("picks up a missed report comment when polled", async () => {
    vi.setSystemTime(ISSUE_CREATED_AT + 4 * 60_000);
    const token = await createSession(ctx.env);
    const row = await seedRequest(ctx.env, { state: "running" });
    routes[`GET ${GH}/issues/142/comments`] = (url) => {
      expect(url.searchParams.get("since")).toBe("2026-11-23T10:00:00Z");
      return jsonRes([
        { id: 1, body: "looks good", created_at: "2026-11-23T10:01:00Z", user: { login: "pnettto" } },
        { id: 2, body: JSON.parse(fixture("issue_comment.created")).comment.body, created_at: "2026-11-23T10:03:00Z", user: { login: "github-actions[bot]" } },
      ]);
    };
    const view = (await (await call(`/requests/${row.id}`, token)).json()) as RequestView;
    expect(view).toMatchObject({ state: "succeeded", prNumber: 143, previewUrl: "https://hawk-pi-issue-142.example.workers.dev" });
  });

  it("finds a missed deploy run, or gives up after 5 minutes", async () => {
    const token = await createSession(ctx.env);
    vi.setSystemTime(REPORT_AT + 3 * 60_000);
    const a = await seedRequest(ctx.env, { state: "integrating", merge_sha: MERGE_SHA, merged_at: REPORT_AT });
    routes[`GET ${GH}/actions/runs`] = (url) => {
      expect(url.searchParams.get("head_sha")).toBe(MERGE_SHA);
      return jsonRes({ workflow_runs: [{ id: 555, name: "deploy", event: "push", status: "completed", conclusion: "success", display_title: "x", html_url: "https://github.com/pnettto/hawk/actions/runs/555", created_at: "2026-11-23T10:06:00Z", actor: null }] });
    };
    expect(((await (await call(`/requests/${a.id}`, token)).json()) as RequestView).state).toBe("live");

    const b = await seedRequest(ctx.env, { state: "integrating", client_request_id: "b", issue_number: 2, merge_sha: "d".repeat(40), merged_at: REPORT_AT - 3 * 60_000 });
    routes[`GET ${GH}/actions/runs`] = () => jsonRes({ workflow_runs: [] });
    expect(((await (await call(`/requests/${b.id}`, token)).json()) as RequestView)).toMatchObject({
      state: "merged",
      message: "Merged. No production deploy was triggered.",
    });
  });
});
