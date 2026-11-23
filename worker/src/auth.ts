import { decrypt, encrypt, randomToken, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { publicUrl } from "./env";
import { exchangeCode, getUser, refreshAccessToken } from "./github";
import { HttpError, redirect } from "./http";

export const STATE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

export interface SessionRow {
  id: string;
  github_login: string;
  access_token_enc: string;
  access_expires_at: number;
  refresh_token_enc: string;
  refresh_expires_at: number;
  created_at: number;
  expires_at: number;
}

function extensionRedirect(env: Env, fragment: string): string {
  return `https://${env.EXTENSION_ID}.chromiumapp.org/cb#${fragment}`;
}

export async function handleAuthStart(env: Env): Promise<Response> {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(now - STATE_TTL_MS).run();
  const state = randomToken();
  await env.DB.prepare("INSERT INTO oauth_states (state, created_at) VALUES (?, ?)").bind(state, now).run();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${publicUrl(env)}/auth/callback`);
  url.searchParams.set("state", state);
  return redirect(url.toString());
}

export async function handleAuthCallback(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code) return redirect(extensionRedirect(env, "error=invalid_request"));

  // Consume the state whatever happens next.
  const row = await env.DB.prepare("DELETE FROM oauth_states WHERE state = ? RETURNING created_at")
    .bind(state)
    .first<{ created_at: number }>();
  if (!row || Date.now() - row.created_at > STATE_TTL_MS) {
    return redirect(extensionRedirect(env, "error=invalid_state"));
  }

  let tokens;
  let login: string;
  try {
    tokens = await exchangeCode(env, code);
    login = (await getUser(tokens.accessToken)).login;
  } catch {
    return redirect(extensionRedirect(env, "error=github"));
  }
  if (login.toLowerCase() !== env.ALLOWED_LOGIN.toLowerCase()) {
    return redirect(extensionRedirect(env, "error=forbidden"));
  }

  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, github_login, access_token_enc, access_expires_at, refresh_token_enc,
       refresh_expires_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(token),
      login,
      await encrypt(tokens.accessToken, env.TOKEN_ENC_KEY),
      tokens.accessExpiresAt,
      await encrypt(tokens.refreshToken, env.TOKEN_ENC_KEY),
      tokens.refreshExpiresAt,
      now,
      now + SESSION_TTL_MS,
    )
    .run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
  return redirect(extensionRedirect(env, `session=${encodeURIComponent(token)}`));
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1] ?? null;
}

/** Look up the session for a token. Throws 401 if missing, expired or not allowed. */
export async function requireSession(env: Env, token: string | null): Promise<SessionRow> {
  if (!token) throw new HttpError(401, "unauthorized");
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(await sha256Hex(token))
    .first<SessionRow>();
  if (!session || session.expires_at < Date.now()) throw new HttpError(401, "unauthorized");
  if (session.github_login.toLowerCase() !== env.ALLOWED_LOGIN.toLowerCase()) throw new HttpError(401, "unauthorized");
  return session;
}

/** A valid GitHub user access token for the session, refreshing it if needed. */
export async function accessToken(env: Env, session: SessionRow): Promise<string> {
  const now = Date.now();
  if (session.access_expires_at - REFRESH_MARGIN_MS > now) {
    return decrypt(session.access_token_enc, env.TOKEN_ENC_KEY);
  }
  const refresh = await decrypt(session.refresh_token_enc, env.TOKEN_ENC_KEY);
  if (!refresh || session.refresh_expires_at < now) throw new HttpError(401, "github_reauth", "GitHub sign-in expired");
  let tokens;
  try {
    tokens = await refreshAccessToken(env, refresh);
  } catch {
    throw new HttpError(401, "github_reauth", "GitHub sign-in expired");
  }
  const accessEnc = await encrypt(tokens.accessToken, env.TOKEN_ENC_KEY);
  const refreshEnc = await encrypt(tokens.refreshToken || refresh, env.TOKEN_ENC_KEY);
  const refreshExpires = tokens.refreshToken ? tokens.refreshExpiresAt : session.refresh_expires_at;
  await env.DB.prepare(
    "UPDATE sessions SET access_token_enc = ?, access_expires_at = ?, refresh_token_enc = ?, refresh_expires_at = ? WHERE id = ?",
  )
    .bind(accessEnc, tokens.accessExpiresAt, refreshEnc, refreshExpires, session.id)
    .run();
  Object.assign(session, {
    access_token_enc: accessEnc,
    access_expires_at: tokens.accessExpiresAt,
    refresh_token_enc: refreshEnc,
    refresh_expires_at: refreshExpires,
  });
  return tokens.accessToken;
}

export async function handleLogout(env: Env, request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
  return new Response(null, { status: 204 });
}
