import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestView } from "@web-issuer/shared";
import { handle } from "../src/app";
import { decrypt, sha256Hex } from "../src/crypto";
import type { SessionRow } from "../src/auth";
import { createSession, ISSUE_CREATED_AT, makeEnv, seedRequest } from "./helpers";

let ctx: ReturnType<typeof makeEnv>;
let fetchMock: ReturnType<typeof vi.fn>;
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;

const BASE = "https://issuer.pnetto.store";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

beforeEach(() => {
  ctx = makeEnv();
  routes = {};
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

const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  headers.set("Origin", ORIGIN);
  return handle(new Request(`${BASE}${path}`, { ...init, headers }), ctx.env);
}

const issueBody = (overrides: Record<string, unknown> = {}) => ({
  clientRequestId: "11111111-1111-4111-8111-111111111111",
  repo: "pnettto/hawk",
  title: "Improve the pricing page",
  pageUrl: "https://example.com/pricing?session=abc#x",
  pageTitle: "Pricing",
  dryRun: false,
  annotations: [
    {
      id: "a1",
      comment: "Make the upgrade button less prominent",
      locator: "#upgrade",
      tag: "button",
      role: "button",
      kind: "button",
      text: "Upgrade",
      rect: { x: 912, y: 184, width: 120, height: 40 },
      viewport: { width: 1440, height: 900 },
      scroll: { x: 0, y: 0 },
    },
  ],
  ...overrides,
});

function postIssue(token: string, body: unknown) {
  return api("/issues", { method: "POST", token, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

describe("health and CORS", () => {
  it("returns ok", async () => {
    const res = await api("/health");
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("answers preflight for the extension only", async () => {
    const ok = await api("/issues", { method: "OPTIONS" });
    expect(ok.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    const other = await handle(new Request(`${BASE}/issues`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), ctx.env);
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("requires a session", async () => {
    expect((await api("/repos")).status).toBe(401);
    expect((await api("/repos", { token: "nope" })).status).toBe(401);
  });

  it("rejects sessions for other logins", async () => {
    const token = await createSession(ctx.env, { login: "someone-else" });
    expect((await api("/repos", { token })).status).toBe(401);
  });
});

describe("POST /issues", () => {
  it("creates the issue once per clientRequestId", async () => {
    const token = await createSession(ctx.env);
    let sent: { title: string; body: string } | undefined;
    routes["POST https://api.github.com/repos/pnettto/hawk/issues"] = (_url, init) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer gho_access");
      sent = JSON.parse(String(init.body));
      return jsonRes({ number: 142, html_url: "https://github.com/pnettto/hawk/issues/142", created_at: "2026-11-23T10:00:00Z" }, 201);
    };

    const first = (await (await postIssue(token, issueBody())).json()) as RequestView;
    expect(first).toMatchObject({ state: "created", issueNumber: 142, issueUrl: "https://github.com/pnettto/hawk/issues/142", dryRun: false });
    expect(sent?.title).toBe("Improve the pricing page");
    expect(sent?.body.startsWith("/pi Apply the requested changes below.\n")).toBe(true);
    expect(sent?.body).toContain("Pricing — https://example.com/pricing?session=REDACTED\n");
    expect(sent?.body).toContain(`<!-- web-issuer:${first.id} -->`);

    const second = (await (await postIssue(token, issueBody())).json()) as RequestView;
    expect(second.id).toBe(first.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dry runs omit /pi and are untracked", async () => {
    const token = await createSession(ctx.env);
    let body = "";
    routes["POST https://api.github.com/repos/pnettto/hawk/issues"] = (_url, init) => {
      body = JSON.parse(String(init.body)).body;
      return jsonRes({ number: 5, html_url: "https://github.com/pnettto/hawk/issues/5", created_at: "2026-11-23T10:00:00Z" }, 201);
    };
    const res = (await (await postIssue(token, issueBody({ dryRun: true }))).json()) as RequestView;
    expect(res.state).toBe("untracked");
    expect(body.startsWith("> web-issuer dry run: automation not triggered.")).toBe(true);
    expect(body).not.toMatch(/^\/pi/m);
  });

  it("untracked repos still get issues", async () => {
    const token = await createSession(ctx.env);
    routes["POST https://api.github.com/repos/pnettto/other/issues"] = () =>
      jsonRes({ number: 1, html_url: "https://github.com/pnettto/other/issues/1", created_at: "2026-11-23T10:00:00Z" }, 201);
    const res = (await (await postIssue(token, issueBody({ repo: "pnettto/other" }))).json()) as RequestView;
    expect(res.state).toBe("untracked");
  });

  it("keeps nothing on GitHub failure so a retry works", async () => {
    const token = await createSession(ctx.env);
    routes["POST https://api.github.com/repos/pnettto/hawk/issues"] = () => jsonRes({ message: "Server Error" }, 500);
    const failed = await postIssue(token, issueBody());
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: "github_error", message: "Server Error" });

    routes["POST https://api.github.com/repos/pnettto/hawk/issues"] = () =>
      jsonRes({ number: 142, html_url: "https://github.com/pnettto/hawk/issues/142", created_at: "2026-11-23T10:00:00Z" }, 201);
    expect((await postIssue(token, issueBody())).status).toBe(200);
  });

  it("validates input", async () => {
    const token = await createSession(ctx.env);
    expect((await postIssue(token, issueBody({ annotations: [] }))).status).toBe(400);
    expect((await postIssue(token, issueBody({ repo: "../etc" }))).status).toBe(400);
    expect((await postIssue(token, issueBody({ title: " " }))).status).toBe(400);
    expect((await postIssue(token, issueBody({ pageUrl: "javascript:alert(1)" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired user token", async () => {
    const token = await createSession(ctx.env, { accessExpiresAt: Date.now() - 1000 });
    routes["POST https://github.com/login/oauth/access_token"] = (_url, init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_refresh" });
      return jsonRes({ access_token: "gho_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15897600 });
    };
    routes["POST https://api.github.com/repos/pnettto/hawk/issues"] = (_url, init) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer gho_new");
      return jsonRes({ number: 1, html_url: "https://github.com/pnettto/hawk/issues/1", created_at: "2026-11-23T10:00:00Z" }, 201);
    };
    expect((await postIssue(token, issueBody())).status).toBe(200);
    const row = await ctx.env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(await sha256Hex(token)).first<SessionRow>();
    expect(await decrypt(row!.access_token_enc, ctx.env.TOKEN_ENC_KEY)).toBe("gho_new");
    expect(await decrypt(row!.refresh_token_enc, ctx.env.TOKEN_ENC_KEY)).toBe("ghr_new");
  });

  it("returns 401 when the refresh fails", async () => {
    const token = await createSession(ctx.env, { accessExpiresAt: Date.now() - 1000 });
    routes["POST https://github.com/login/oauth/access_token"] = () => jsonRes({ error: "bad_refresh_token" });
    const res = await postIssue(token, issueBody());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "github_reauth" });
  });
});

describe("GET /repos", () => {
  it("lists installed repos with tracking info", async () => {
    const token = await createSession(ctx.env);
    routes["GET https://api.github.com/user/installations"] = () => jsonRes({ installations: [{ id: 9 }] });
    routes["GET https://api.github.com/user/installations/9/repositories"] = () =>
      jsonRes({ total_count: 2, repositories: [{ full_name: "pnettto/other" }, { full_name: "pnettto/hawk" }] });
    expect(await (await api("/repos", { token })).json()).toEqual({
      login: "pnettto",
      repos: [
        { fullName: "pnettto/hawk", tracked: true },
        { fullName: "pnettto/other", tracked: false },
      ],
    });
  });
});

describe("GET /requests/:id", () => {
  it("returns the request to its owner only", async () => {
    const token = await createSession(ctx.env);
    const other = await createSession(ctx.env, { login: "pnettto" });
    const row = await seedRequest(ctx.env, { state: "running" });
    const res = (await (await api(`/requests/${row.id}`, { token })).json()) as RequestView;
    expect(res).toMatchObject({ id: row.id, state: "running", stalled: false, actionsUrl: "https://github.com/pnettto/hawk/actions" });
    expect((await api(`/requests/${row.id}`, { token: other })).status).toBe(200);
    const foreign = await seedRequest(ctx.env, { github_login: "someone", client_request_id: "x", issue_number: 1 });
    expect((await api(`/requests/${foreign.id}`, { token })).status).toBe(404);
  });

  it("safety net: marks started from the 👀 reaction, and flags stalls after 10 min", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ISSUE_CREATED_AT + 4 * 60_000);
    const token = await createSession(ctx.env);
    const row = await seedRequest(ctx.env);
    routes["GET https://api.github.com/repos/pnettto/hawk/actions/runs"] = (url) => {
      expect(url.searchParams.get("created")).toBe(">=2026-11-23T09:59:50Z");
      return jsonRes({ workflow_runs: [] });
    };
    routes["GET https://api.github.com/repos/pnettto/hawk/issues/142/reactions"] = () => jsonRes([{ content: "eyes", user: { login: "github-actions[bot]" } }]);
    const res = (await (await api(`/requests/${row.id}`, { token })).json()) as RequestView;
    expect(res.state).toBe("started");

    const stale = await seedRequest(ctx.env, { client_request_id: "s", issue_number: 9, issue_created_at: ISSUE_CREATED_AT - 20 * 60_000 });
    routes["GET https://api.github.com/repos/pnettto/hawk/issues/9/reactions"] = () => jsonRes([]);
    const view = (await (await api(`/requests/${stale.id}`, { token })).json()) as RequestView;
    expect(view).toMatchObject({ state: "created", stalled: true, message: "Automation hasn't started" });
  });
});

describe("auth flow", () => {
  async function start() {
    const res = await api("/auth/start");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("Iv1.test");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://issuer.pnetto.store/auth/callback");
    return loc.searchParams.get("state")!;
  }

  function mockGitHub(login: string) {
    routes["POST https://github.com/login/oauth/access_token"] = (_url, init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ code: "the-code", client_secret: "client-secret" });
      return jsonRes({ access_token: "gho_x", expires_in: 28800, refresh_token: "ghr_x", refresh_token_expires_in: 15897600 });
    };
    routes["GET https://api.github.com/user"] = () => jsonRes({ login });
  }

  it("signs in the allowed login and the session works", async () => {
    const state = await start();
    mockGitHub("pnettto");
    const res = await api(`/auth/callback?code=the-code&state=${state}`);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith("https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb#session=")).toBe(true);
    const session = decodeURIComponent(loc.split("#session=")[1]!);

    routes["GET https://api.github.com/user/installations"] = () => jsonRes({ installations: [] });
    expect((await api("/repos", { token: session })).status).toBe(200);

    expect((await api("/auth/logout", { method: "POST", token: session })).status).toBe(204);
    expect((await api("/repos", { token: session })).status).toBe(401);
  });

  it("rejects logins outside the allow-list", async () => {
    const state = await start();
    mockGitHub("intruder");
    const res = await api(`/auth/callback?code=the-code&state=${state}`);
    expect(res.headers.get("Location")).toBe("https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb#error=forbidden");
    const count = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects unknown or reused states", async () => {
    const state = await start();
    mockGitHub("pnettto");
    expect((await api(`/auth/callback?code=the-code&state=bogus`)).headers.get("Location")).toContain("#error=invalid_state");
    await api(`/auth/callback?code=the-code&state=${state}`);
    expect((await api(`/auth/callback?code=the-code&state=${state}`)).headers.get("Location")).toContain("#error=invalid_state");
  });
});
