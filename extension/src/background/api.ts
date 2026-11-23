import type { CreateFollowupRequest, CreateIssueRequest, ReposResponse, RequestView } from "@wish/shared";
import { API_BASE } from "../config";
import { chromeStore, KEYS } from "../storage";

// The only module that talks to the Worker. Used by the service worker and the
// settings page (both extension origins, which the Worker's CORS allows).
// Content scripts never see the session token.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

async function call<T>(session: string, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json", ...init.headers },
    });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, data.error ?? "error", data.message ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  repos: (session: string) => call<ReposResponse>(session, "/repos"),
  createIssue: (session: string, body: CreateIssueRequest) =>
    call<RequestView>(session, "/issues", { method: "POST", body: JSON.stringify(body) }),
  request: (session: string, id: string) => call<RequestView>(session, `/requests/${encodeURIComponent(id)}`),
  followup: (session: string, id: string, body: CreateFollowupRequest) =>
    call<RequestView>(session, `/requests/${encodeURIComponent(id)}/followups`, { method: "POST", body: JSON.stringify(body) }),
  integrate: (session: string, id: string) =>
    call<RequestView>(session, `/requests/${encodeURIComponent(id)}/integrate`, { method: "POST" }),
  logout: (session: string) => call<void>(session, "/auth/logout", { method: "POST" }),
};

export function liveUrl(session: string, id: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/requests/${encodeURIComponent(id)}/live?session=${encodeURIComponent(session)}`;
}

/** Sign in through the Worker's GitHub App flow. Returns the session token. */
export async function connectGitHub(): Promise<string> {
  const redirect = await chrome.identity.launchWebAuthFlow({ url: `${API_BASE}/auth/start`, interactive: true });
  if (!redirect) throw new Error("Sign-in was cancelled.");
  const fragment = new URLSearchParams(new URL(redirect).hash.slice(1));
  const error = fragment.get("error");
  if (error === "forbidden") throw new Error("This GitHub account isn't allowed to use Wish.");
  if (error) throw new Error("GitHub sign-in failed. Try again.");
  const session = fragment.get("session");
  if (!session) throw new Error("GitHub sign-in failed. Try again.");
  return session;
}

export function getSession(): Promise<string | undefined> {
  return chromeStore.get<string>(KEYS.session);
}

export async function signOut(): Promise<void> {
  const session = await getSession();
  await chromeStore.remove(KEYS.session);
  if (session) await api.logout(session).catch(() => undefined);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
