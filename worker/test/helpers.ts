import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { encrypt, hmacSha256Hex, randomToken, sha256Hex } from "../src/crypto";
import type { Env } from "../src/env";
import type { RequestRow } from "../src/requests";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Minimal D1 implementation over node:sqlite, enough for the Worker's queries. */
class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new FakeStatement(this.db, this.sql, params.map((p) => (p === undefined ? null : p)) as SQLInputValue[]);
  }
  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row ? { ...row } : null) as T | null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })) as T[], success: true, meta: {} };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
}

export function fakeD1(): { d1: D1Database; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`${MIGRATIONS}/${file}`, "utf8"));
  }
  const d1 = { prepare: (sql: string) => new FakeStatement(db, sql) } as unknown as D1Database;
  return { d1, db };
}

export interface LiveCall {
  name: string;
  path: string;
  body: unknown;
}

export function fakeNamespace(): { ns: DurableObjectNamespace; calls: LiveCall[] } {
  const calls: LiveCall[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        const text = typeof init?.body === "string" ? init.body : "";
        calls.push({ name: id.name, path: url.pathname, body: text ? JSON.parse(text) : null });
        return new Response(null, { status: 204 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { ns, calls };
}

export const WEBHOOK_SECRET = "test-webhook-secret";

export function makeEnv() {
  const { d1, db } = fakeD1();
  const { ns, calls } = fakeNamespace();
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const env: Env = {
    DB: d1,
    REQUEST_LIVE: ns,
    GITHUB_CLIENT_ID: "Iv1.test",
    GITHUB_APP_ID: "1",
    GITHUB_CLIENT_SECRET: "client-secret",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TOKEN_ENC_KEY: key,
    ALLOWED_LOGIN: "pnettto",
    EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop",
    TRACKED_REPOS: "pnettto/hawk",
    PUBLIC_URL: "https://issuer.pnetto.store",
  };
  return { env, db, liveCalls: calls };
}

export async function createSession(
  env: Env,
  opts: { login?: string; accessExpiresAt?: number; refreshToken?: string } = {},
): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, github_login, access_token_enc, access_expires_at, refresh_token_enc, refresh_expires_at, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(token),
      opts.login ?? "pnettto",
      await encrypt("gho_access", env.TOKEN_ENC_KEY),
      opts.accessExpiresAt ?? now + 3600_000,
      await encrypt(opts.refreshToken ?? "ghr_refresh", env.TOKEN_ENC_KEY),
      now + 30 * 24 * 3600_000,
      now,
      now + 30 * 24 * 3600_000,
    )
    .run();
  return token;
}

export const ISSUE_CREATED_AT = Date.parse("2026-11-23T10:00:00Z");

export async function seedRequest(env: Env, overrides: Partial<RequestRow> = {}): Promise<RequestRow> {
  const row: RequestRow = {
    id: crypto.randomUUID(),
    client_request_id: crypto.randomUUID(),
    github_login: "pnettto",
    repo: "pnettto/hawk",
    issue_number: 142,
    issue_url: "https://github.com/pnettto/hawk/issues/142",
    issue_created_at: ISSUE_CREATED_AT,
    title: "Improve the pricing page",
    page_url: "https://example.com/pricing",
    dry_run: 0,
    state: "created",
    run_id: null,
    run_url: null,
    pr_url: null,
    preview_url: null,
    message: null,
    created_at: ISSUE_CREATED_AT,
    updated_at: ISSUE_CREATED_AT,
    report_at: null,
    merge_sha: null,
    merged_at: null,
    deploy_run_id: null,
    deploy_run_url: null,
    ...overrides,
  };
  const keys = Object.keys(row);
  await env.DB.prepare(`INSERT INTO requests (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
  return row;
}

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8");
}

export async function webhookRequest(event: string, body: string, secret = WEBHOOK_SECRET): Promise<Request> {
  return new Request("https://issuer.pnetto.store/webhooks/github", {
    method: "POST",
    headers: {
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": `sha256=${await hmacSha256Hex(secret, body)}`,
      "Content-Type": "application/json",
    },
    body,
  });
}

/** Load fixture `<event>.<variant>` and build a signed webhook request. */
export function fixtureRequest(name: string): Promise<Request> {
  return webhookRequest(name.split(".")[0]!, fixture(name));
}
