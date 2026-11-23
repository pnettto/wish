export interface Env {
  DB: D1Database;
  REQUEST_LIVE: DurableObjectNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_APP_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  /** 32 random bytes, base64. */
  TOKEN_ENC_KEY: string;
  ALLOWED_LOGIN: string;
  EXTENSION_ID: string;
  /** Comma-separated "owner/name" list. */
  TRACKED_REPOS: string;
  /** Public origin of this Worker, e.g. https://issuer.pnetto.store */
  PUBLIC_URL: string;
}

export function trackedRepos(env: Env): string[] {
  return env.TRACKED_REPOS.split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

export function isTracked(env: Env, repo: string): boolean {
  return trackedRepos(env).includes(repo.toLowerCase());
}

export function publicUrl(env: Env): string {
  return (env.PUBLIC_URL || "https://issuer.pnetto.store").replace(/\/+$/, "");
}
