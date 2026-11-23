import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import { applyPendingFailure, getRequest, matchRun } from "../src/requests";
import { fixture, fixtureRequest, ISSUE_CREATED_AT, makeEnv, seedRequest, webhookRequest } from "./helpers";

let ctx: ReturnType<typeof makeEnv>;

beforeEach(() => {
  ctx = makeEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ISSUE_CREATED_AT + 60_000);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function send(name: string) {
  const res = await handle(await fixtureRequest(name), ctx.env);
  expect(res.status).toBe(204);
}

const broadcasts = () => ctx.liveCalls.filter((c) => c.path === "/broadcast");

describe("webhook signature", () => {
  it("accepts a valid signature", async () => {
    const res = await handle(await fixtureRequest("issue_comment.created"), ctx.env);
    expect(res.status).toBe(204);
  });

  it("rejects an invalid signature", async () => {
    const req = await webhookRequest("issue_comment", fixture("issue_comment.created"), "wrong-secret");
    expect((await handle(req, ctx.env)).status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    const good = await fixtureRequest("issue_comment.created");
    const req = new Request(good.url, { method: "POST", headers: good.headers, body: `${fixture("issue_comment.created")} ` });
    expect((await handle(req, ctx.env)).status).toBe(401);
  });

  it("rejects a missing signature", async () => {
    const req = new Request("https://issuer.pnetto.store/webhooks/github", {
      method: "POST",
      headers: { "X-GitHub-Event": "issue_comment" },
      body: fixture("issue_comment.created"),
    });
    expect((await handle(req, ctx.env)).status).toBe(401);
  });
});

describe("state transitions", () => {
  it("follows run → job → report to succeeded", async () => {
    const seeded = await seedRequest(ctx.env);

    await send("workflow_run.in_progress");
    let row = await getRequest(ctx.env, seeded.id);
    expect(row).toMatchObject({ state: "started", run_id: 1234567890, run_url: "https://github.com/pnettto/hawk/actions/runs/1234567890" });

    await send("workflow_job.in_progress");
    row = await getRequest(ctx.env, seeded.id);
    expect(row?.state).toBe("running");

    await send("issue_comment.created");
    row = await getRequest(ctx.env, seeded.id);
    expect(row).toMatchObject({
      state: "succeeded",
      pr_url: "https://github.com/pnettto/hawk/pull/143",
      preview_url: "https://hawk-pi-issue-142.example.workers.dev",
      message: "Made the upgrade button secondary and added a tooltip explaining usage limits.",
    });

    const states = broadcasts().map((c) => (c.body as { request: { state: string } }).request.state);
    expect(states).toEqual(["started", "running", "succeeded"]);
    expect(broadcasts().every((c) => c.name === seeded.id)).toBe(true);
  });

  it.each([
    ["issue_comment.checks_failed", "checks_failed", { pr_url: "https://github.com/pnettto/hawk/pull/143", preview_url: null, message: "Preview deploy failed." }],
    ["issue_comment.no_changes", "no_changes", { pr_url: null, preview_url: null }],
    ["issue_comment.failed", "failed", { run_id: 1234567890 }],
  ] as const)("%s → %s", async (name, state, extra) => {
    const seeded = await seedRequest(ctx.env, { state: "running", run_id: 1234567890 });
    await send(name);
    expect(await getRequest(ctx.env, seeded.id)).toMatchObject({ state, ...extra });
  });

  it("only counts the first report", async () => {
    const seeded = await seedRequest(ctx.env);
    await send("issue_comment.created");
    await send("issue_comment.failed");
    expect((await getRequest(ctx.env, seeded.id))?.state).toBe("succeeded");
    expect(broadcasts()).toHaveLength(1);
  });

  it.each(["issue_comment.pr_copy", "issue_comment.non_bot", "issue_comment.unknown_issue"])("ignores %s", async (name) => {
    const seeded = await seedRequest(ctx.env);
    await send(name);
    expect((await getRequest(ctx.env, seeded.id))?.state).toBe("created");
    expect(broadcasts()).toHaveLength(0);
  });

  it("ignores repos that aren't tracked", async () => {
    const seeded = await seedRequest(ctx.env, { repo: "pnettto/other", state: "untracked" });
    const tracked = await seedRequest(ctx.env, { issue_number: 7 });
    await send("issue_comment.other_repo");
    expect((await getRequest(ctx.env, seeded.id))?.state).toBe("untracked");
    expect((await getRequest(ctx.env, tracked.id))?.state).toBe("created");
    expect(broadcasts()).toHaveLength(0);
  });

  it("ignores dry-run requests", async () => {
    const seeded = await seedRequest(ctx.env, { dry_run: 1, state: "untracked" });
    await send("workflow_run.in_progress");
    await send("issue_comment.created");
    expect(await getRequest(ctx.env, seeded.id)).toMatchObject({ state: "untracked", run_id: null });
  });

  it("ignores reports posted before the issue was created", async () => {
    const seeded = await seedRequest(ctx.env, { issue_created_at: Date.parse("2026-11-23T10:06:00Z") });
    await send("issue_comment.created");
    expect((await getRequest(ctx.env, seeded.id))?.state).toBe("created");
  });

  it("unlinks a run whose pi job was skipped", async () => {
    const seeded = await seedRequest(ctx.env);
    await send("workflow_run.in_progress");
    await send("workflow_job.skipped");
    expect(await getRequest(ctx.env, seeded.id)).toMatchObject({ state: "created", run_id: null, run_url: null });
  });

  it("doesn't match runs outside the 2 minute window", async () => {
    const seeded = await seedRequest(ctx.env, { issue_created_at: Date.parse("2026-11-23T09:50:00Z") });
    await send("workflow_run.in_progress");
    expect((await getRequest(ctx.env, seeded.id))?.run_id).toBeNull();
  });

  it("schedules a failure for a failed run and applies it if no report arrives", async () => {
    const seeded = await seedRequest(ctx.env);
    await send("workflow_run.completed_failure");
    const scheduled = ctx.liveCalls.find((c) => c.path === "/schedule-failure");
    expect(scheduled?.body).toMatchObject({ requestId: seeded.id, runId: 1234567890, conclusion: "failure" });
    expect((await getRequest(ctx.env, seeded.id))?.state).toBe("started");

    await applyPendingFailure(ctx.env, scheduled!.body as never);
    expect(await getRequest(ctx.env, seeded.id)).toMatchObject({
      state: "failed",
      run_url: "https://github.com/pnettto/hawk/actions/runs/1234567890",
    });
  });

  it("keeps the report outcome if it arrives before the failure timer", async () => {
    const seeded = await seedRequest(ctx.env);
    await send("workflow_run.completed_failure");
    await send("issue_comment.checks_failed");
    const scheduled = ctx.liveCalls.find((c) => c.path === "/schedule-failure");
    await applyPendingFailure(ctx.env, scheduled!.body as never);
    expect((await getRequest(ctx.env, seeded.id))?.state).toBe("checks_failed");
  });
});

describe("matchRun", () => {
  it("prefers the request whose title matches display_title", async () => {
    const a = await seedRequest(ctx.env, { title: "Other change", issue_number: 1, issue_created_at: ISSUE_CREATED_AT + 4_000 });
    const b = await seedRequest(ctx.env, { title: "Improve the pricing page", issue_number: 2 });
    const run = { id: 1, createdAt: ISSUE_CREATED_AT + 5_000, displayTitle: "Improve the pricing page" };
    expect(matchRun([a, b], run)?.id).toBe(b.id);
    expect(matchRun([a, b], { ...run, displayTitle: "nope" })?.id).toBe(a.id);
  });
});
