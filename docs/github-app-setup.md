# GitHub App setup (owner, one time)

The backend signs you in through a GitHub App and receives its webhooks. Create the app under your personal account. This takes about 5 minutes.

Before starting, the Worker should be deployable at `https://issuer.pnetto.store` (webhook deliveries fail until it is, which is harmless).

## 1. Create the app

Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** (<https://github.com/settings/apps/new>).

| Field | Value |
|---|---|
| GitHub App name | `web-issuer-pnettto` (must be globally unique) |
| Homepage URL | `https://issuer.pnetto.store` |
| Callback URL | `https://issuer.pnetto.store/auth/callback` |
| Expire user authorization tokens | ✅ checked |
| Request user authorization (OAuth) during installation | ☐ unchecked |
| Enable Device Flow | ☐ unchecked |
| Setup URL | empty |
| Webhook → Active | ✅ checked |
| Webhook URL | `https://issuer.pnetto.store/webhooks/github` |
| Webhook secret | generate one: `openssl rand -hex 32` (keep it for step 3) |
| SSL verification | Enabled |

**Repository permissions** (leave all others as *No access*):

| Permission | Access |
|---|---|
| Actions | Read-only |
| Contents | Read and write (needed to merge with **Integrate changes**) |
| Issues | Read and write |
| Metadata | Read-only (mandatory) |
| Pull requests | Read and write (needed to merge with **Integrate changes**) |

If you change permissions after installing, accept them on the installation: <https://github.com/settings/installations> → **Configure** → **Review request** → **Accept new permissions**.

**Account permissions:** none.

**Subscribe to events:** ✅ Issue comment, ✅ Workflow job, ✅ Workflow run. These checkboxes only appear after the permissions above are set; without them no progress is tracked (Recent deliveries then only shows `ping` and `installation`).

**Where can this GitHub App be installed?** Only on this account.

Click **Create GitHub App**.

## 2. Collect credentials

On the app's settings page:

1. Note the **App ID** and **Client ID**.
2. **Client secrets → Generate a new client secret.** Copy it now; it's shown once.
3. A private key is **not** needed for v1. Don't generate one.

## 3. Configure the Worker

From `worker/` (values never go in git):

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET   # from step 2
npx wrangler secret put GITHUB_WEBHOOK_SECRET  # from step 1
npx wrangler secret put TOKEN_ENC_KEY          # openssl rand -base64 32
```

Put `GITHUB_CLIENT_ID` and `GITHUB_APP_ID` in `wrangler.jsonc` `vars` (they aren't secret). `ALLOWED_LOGIN=pnettto`, `TRACKED_REPOS=pnettto/hawk` and `EXTENSION_ID=ndghjkhgmanjhlfhahcbbmpfofdmldbc` (see the README) are already set there. Redeploy (`npx wrangler deploy`) after changing vars.

For local development, put the same keys in `worker/.dev.vars` (gitignored).

## 4. Install the app on hawk only

App settings → **Install App** → your account → **Only select repositories** → `pnettto/hawk` → **Install**.

This only grants the app access. Nothing in the hawk repo changes.

## 5. Check it

1. Load the extension and click **Connect GitHub**. GitHub asks you to authorize the app once.
2. `pnettto/hawk` appears in the repo picker.
3. After the first issue, App settings → **Advanced → Recent deliveries** shows `issue_comment` / `workflow_*` deliveries with 2xx responses.
