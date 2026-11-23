import type { LiveMessage, ReposResponse } from "@web-issuer/shared";
import { accessToken, bearerToken, handleAuthCallback, handleAuthStart, handleLogout, requireSession } from "./auth";
import type { Env } from "./env";
import { isTracked } from "./env";
import { GitHubError, listInstalledRepos } from "./github";
import { corsHeaders, errorResponse, HttpError, json, withHeaders } from "./http";
import { handleCreateIssue, handleGetRequest, handleIntegrate, loadOwnedRequest, toView } from "./requests";
import { handleWebhook } from "./webhooks";

const REQUEST_PATH = /^\/requests\/([0-9a-f-]{36})(\/live)?$/;
const INTEGRATE_PATH = /^\/requests\/([0-9a-f-]{36})\/integrate$/;

export async function handle(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env, request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    return withHeaders(await route(request, env), cors);
  } catch (err) {
    if (err instanceof HttpError) return withHeaders(errorResponse(err), cors);
    if (err instanceof GitHubError) {
      const status = err.status === 401 ? 401 : 502;
      return withHeaders(json({ error: status === 401 ? "github_reauth" : "github_error", message: err.message }, status), cors);
    }
    console.error(err);
    return withHeaders(json({ error: "internal" }, 500), cors);
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/health") return json({ ok: true });
  if (method === "GET" && pathname === "/auth/start") return handleAuthStart(env);
  if (method === "GET" && pathname === "/auth/callback") return handleAuthCallback(env, url);
  if (method === "POST" && pathname === "/auth/logout") return handleLogout(env, request);
  if (method === "POST" && pathname === "/webhooks/github") return handleWebhook(env, request);

  if (method === "GET" && pathname === "/repos") {
    const session = await requireSession(env, bearerToken(request));
    const repos = await listInstalledRepos(await accessToken(env, session));
    const body: ReposResponse = {
      login: session.github_login,
      repos: repos.map((fullName) => ({ fullName, tracked: isTracked(env, fullName) })),
    };
    return json(body);
  }

  if (method === "POST" && pathname === "/issues") {
    const session = await requireSession(env, bearerToken(request));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, "invalid_request", "JSON body required");
    }
    return json(await handleCreateIssue(env, session, body));
  }

  const integrate = INTEGRATE_PATH.exec(pathname);
  if (method === "POST" && integrate) {
    const session = await requireSession(env, bearerToken(request));
    return json(await handleIntegrate(env, session, integrate[1]!));
  }

  const match = REQUEST_PATH.exec(pathname);
  if (method === "GET" && match) {
    const id = match[1]!;
    if (match[2]) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required");
      const session = await requireSession(env, url.searchParams.get("session"));
      const row = await loadOwnedRequest(env, session, id);
      const initial: LiveMessage = { type: "state", request: toView(row) };
      const headers = new Headers(request.headers);
      headers.set("X-Initial-State", encodeURIComponent(JSON.stringify(initial)));
      const stub = env.REQUEST_LIVE.get(env.REQUEST_LIVE.idFromName(id));
      return stub.fetch(new Request(request.url, { method: "GET", headers }));
    }
    const session = await requireSession(env, bearerToken(request));
    return json(await handleGetRequest(env, session, id));
  }

  throw new HttpError(404, "not_found");
}
