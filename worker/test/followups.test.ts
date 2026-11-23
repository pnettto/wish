import type { RequestView } from "@web-issuer/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/app";
import { applyPendingFailure, getRequest, resetSafetyThrottle } from "../src/requests";
import { createSession, fixtureRequest, makeEnv, seedRequest } from "./helpers";

let ctx: ReturnType<typeof makeEnv>;
let fetchMock: ReturnType<typeof vi.fn>;
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;

const BASE = "https://issuer.pnetto.store";
const GH = "https://api.github.com/repos/pnettto/hawk";
const REPORT_AT = Date.parse("2026-11-23T10:05:00Z");
const FOLLOWUP_AT = Date.parse("2026-11-23T10:15:00Z");

const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  ctx = makeEnv();
  routes = {};
  resetSafetyThrottle();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FOLLOWUP_AT);
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

const followupBody = (overrides: Record<string, unknown> = {}) => ({
  clientFollowupId: "f0000000-0000-4000-8000-000000000001",
  pageUrl: "https://hawk-pi-issue-142.example.workers.dev/pricing?token=abc",
  pageTitle: "Pricing",
  annotations: [
    {
      id: "a1",
      comment: "Tighten the header spacing",
      locator: "header",
      tag: "header",
      role: "banner",
      kind: "header",
      text: "",
      rect: { x: 0, y: 0, width: 1440, height: 80 },
      viewport: { width: 1440, height: 900 },
      scroll: { x: 0, y: 0 },
    },
  ],
  ...overrides,
});

function post(id: string, token: string, body: unknown) {
  return handle(
    new Request(`${BASE}/requests/${id}/followups`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx.env,
  );
}

const succeeded = (over = {}) =>
  seedRequest(ctx.env, {
    state: "succeeded",
    run_id: 1234567890,
    run_url: "https://github.com/pnettto/hawk/actions/runs/1234567890",
    pr_url: "https://github.com/pnettto/hawk/pull/143",
    preview_url: "https://hawk-pi-issue-142.example.workers.dev",
    message: "Made the upgrade button secondary.",
    report_at: REPORT_AT,
    ...over,
  });

function mockComment() {
  const bodies: string[] = [];
  routes[`POST ${GH}/issues/142/comments`] = (_url, init) => {
    bodies.push((JSON.parse(init.body as string) as { body: string }).body);
    return jsonRes({ id: 9001, html_url: "https://github.com/pnettto/hawk/issues/142#issuecomment-9001", created_at: "2026-11-23T10:15:00Z" }, 201);
  };
  return bodies;
}

async function send(name: string) {
  expect((await handle(await fixtureRequest(name), ctx.env)).status).toBe(204);
}

describe("POST /requests/:id/followups", () => {
  it("posts a /pi comment on the issue and starts a new round on the same PR", async () => {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    const bodies = mockComment();

    const res = await post(row.id, token, followupBody());
    expect(res.status).toBe(200);
    const view = (await res.json()) as RequestView;
    expect(view).toMatchObject({
      state: "created",
      followupCount: 1,
      awaitingSince: FOLLOWUP_AT,
      prUrl: "https://github.com/pnettto/hawk/pull/143",
      previewUrl: "https://hawk-pi-issue-142.example.workers.dev",
      runId: null,
      runUrl: null,
      message: null,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.startsWith("/pi Apply the follow-up changes below.")).toBe(true);
    expect(bodies[0]).toContain("Pricing — https://hawk-pi-issue-142.example.workers.dev/pricing?token=REDACTED");
    expect(bodies[0]).toContain("### 1. Tighten the header spacing");
    expect(bodies[0]).toMatch(/<!-- web-issuer-followup:[0-9a-f-]{36} -->/);
    expect(ctx.liveCalls.filter((c) => c.path === "/broadcast")).toHaveLength(1);

    // Idempotent on clientFollowupId (no second comment, no second round).
    const again = (await (await post(row.id, token, followupBody())).json()) as RequestView;
    expect(again.followupCount).toBe(1);
    expect(bodies).toHaveLength(1);
  });

  it("is owner-only and rejects dry runs, merged and running requests", async () => {
    const token = await createSession(ctx.env);
    const other = await createSession(ctx.env, { login: "someone" });
    mockComment();

    const mine = await succeeded();
    expect((await post(mine.id, other, followupBody())).status).toBe(401); // other logins can't sign in at all

    const dry = await seedRequest(ctx.env, { dry_run: 1, state: "untracked", issue_number: 1 });
    const merged = await succeeded({ state: "live", issue_number: 2 });
    const running = await seedRequest(ctx.env, { state: "running", issue_number: 3 });
    const untracked = await seedRequest(ctx.env, { state: "untracked", issue_number: 4, repo: "pnettto/other" });
    const codes = [];
    for (const r of [dry, merged, running, untracked]) {
      const res = await post(r.id, token, followupBody({ clientFollowupId: crypto.randomUUID() }));
      codes.push([res.status, ((await res.json()) as { error: string }).error]);
    }
    expect(codes).toEqual([
      [409, "dry_run"],
      [409, "merged"],
      [409, "in_progress"],
      [409, "untracked"],
    ]);
    expect((await post(crypto.randomUUID(), token, followupBody())).status).toBe(404);
  });

  it("allows refining after no_changes and failed", async () => {
    const token = await createSession(ctx.env);
    mockComment();
    for (const [i, state] of (["no_changes", "failed", "checks_failed"] as const).entries()) {
      const r = await succeeded({ state, issue_number: 142, client_request_id: crypto.randomUUID() });
      const res = await post(r.id, token, followupBody({ clientFollowupId: `f-${i}` }));
      expect(res.status).toBe(200);
    }
  });

  it("keeps nothing when GitHub fails, so a retry works", async () => {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    routes[`POST ${GH}/issues/142/comments`] = () => jsonRes({ message: "Server Error" }, 500);
    expect((await post(row.id, token, followupBody())).status).toBe(502);
    expect((await getRequest(ctx.env, row.id))?.state).toBe("succeeded");
    mockComment();
    expect((await post(row.id, token, followupBody())).status).toBe(200);
  });

  it("validates input", async () => {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    expect((await post(row.id, token, followupBody({ annotations: [] }))).status).toBe(400);
    expect((await post(row.id, token, followupBody({ pageUrl: "javascript:alert(1)" }))).status).toBe(400);
  });
});

describe("follow-up tracking", () => {
  async function refine() {
    const token = await createSession(ctx.env);
    const row = await succeeded();
    mockComment();
    expect((await post(row.id, token, followupBody())).status).toBe(200);
    return { token, row };
  }

  it("follows the issue_comment run to the new report and ignores the old one", async () => {
    const { row } = await refine();
    vi.setSystemTime(FOLLOWUP_AT + 30_000);

    await send("workflow_run.in_progress.issue_comment");
    expect(await getRequest(ctx.env, row.id)).toMatchObject({ state: "started", run_id: 2234567890 });
    await send("workflow_job.in_progress.issue_comment");
    expect((await getRequest(ctx.env, row.id))?.state).toBe("running");

    // The first round's report arriving late (or re-delivered) doesn't count.
    await send("issue_comment.created");
    expect((await getRequest(ctx.env, row.id))?.state).toBe("running");

    await send("issue_comment.followup");
    expect(await getRequest(ctx.env, row.id)).toMatchObject({
      state: "succeeded",
      pr_url: "https://github.com/pnettto/hawk/pull/143",
      preview_url: "https://hawk-pi-issue-142.example.workers.dev",
      run_url: "https://github.com/pnettto/hawk/actions/runs/2234567890",
      message: "Tightened the header spacing.",
      report_at: Date.parse("2026-11-23T10:20:00Z"),
      followup_count: 1,
    });
  });

  it("doesn't match the first round's run to the follow-up", async () => {
    const { row } = await refine();
    await send("workflow_run.in_progress"); // created 10:00:05, before the follow-up
    expect(await getRequest(ctx.env, row.id)).toMatchObject({ state: "created", run_id: null });
  });

  it("drops a failure timer from the previous round", async () => {
    const { row } = await refine();
    await applyPendingFailure(ctx.env, {
      requestId: row.id,
      runId: 1234567890,
      runUrl: "https://github.com/pnettto/hawk/actions/runs/1234567890",
      conclusion: "failure",
    });
    expect((await getRequest(ctx.env, row.id))?.state).toBe("created");
  });

  it("safety net: uses the 👀 on the follow-up comment and issue_comment runs", async () => {
    const { token, row } = await refine();
    vi.setSystemTime(FOLLOWUP_AT + 4 * 60_000);
    const runQueries: string[] = [];
    routes[`GET ${GH}/issues/142/comments`] = () => jsonRes([]);
    routes[`GET ${GH}/actions/runs`] = (url) => {
      runQueries.push(url.searchParams.get("event") ?? "");
      return jsonRes({ workflow_runs: [] });
    };
    routes[`GET ${GH}/issues/comments/9001/reactions`] = () => jsonRes([{ content: "eyes" }]);
    const res = await handle(new Request(`${BASE}/requests/${row.id}`, { headers: { Authorization: `Bearer ${token}` } }), ctx.env);
    expect(((await res.json()) as RequestView).state).toBe("started");
    expect(runQueries).toEqual(["issue_comment"]);
  });
});
