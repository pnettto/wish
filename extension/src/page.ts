import { MERGED_STATES, type RequestView } from "@web-issuer/shared";

export type Support = { ok: true } | { ok: false; reason: string };

/** Whether web-issuer can run on a page, with a human reason if not. */
export function pageSupport(url: string): Support {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "This page can't be annotated." };
  }
  if (u.protocol === "file:") return { ok: false, reason: "Local files aren't supported. Open the page from a web server." };
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "Browser pages can't be annotated. Open a website to add feedback." };
  }
  if (u.hostname === "chromewebstore.google.com" || (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore"))) {
    return { ok: false, reason: "Chrome doesn't allow extensions on the Web Store." };
  }
  if (/\.pdf$/i.test(u.pathname)) return { ok: false, reason: "PDFs can't be annotated." };
  return { ok: true };
}

export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Match pattern covering one origin, e.g. "https://example.com/*". */
export function originPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Minimal Chrome match-pattern test (scheme, host with optional "*." prefix; ports ignored; path must be "/*"). */
export function matchesPattern(url: string, pattern: string): boolean {
  const m = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)\/\*$/.exec(pattern);
  if (!m) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  if (m[1] === "*" ? scheme !== "http" && scheme !== "https" : scheme !== m[1]) return false;
  const host = m[2]!;
  if (host === "*") return true;
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    return u.hostname === base || u.hostname.endsWith(`.${base}`);
  }
  return u.hostname === host;
}

interface PathParts {
  pathname: string;
  search: string;
  hash: string;
}

function withPath(origin: string, loc: PathParts): string {
  return `${origin}${loc.pathname}${loc.search}${loc.hash}`;
}

/** The preview origin of a request, if it has one. */
export function previewOrigin(r: Pick<RequestView, "previewUrl">): string | null {
  return originOf(r.previewUrl);
}

/** Same path on the request's preview deployment (UX-PLAN §4.6). */
export function previewUrlFor(r: Pick<RequestView, "previewUrl">, loc: PathParts): string | null {
  const origin = previewOrigin(r);
  return origin ? withPath(origin, loc) : null;
}

/** Same path on production (the origin the request was filed on). */
export function productionUrlFor(r: Pick<RequestView, "pageUrl">, loc: PathParts): string | null {
  const origin = originOf(r.pageUrl);
  return origin ? withPath(origin, loc) : null;
}

export function pathOf(url: string): PathParts {
  const u = new URL(url);
  return { pathname: u.pathname, search: u.search, hash: u.hash };
}

/** Most recently updated request whose preview is served from `url`'s origin. */
export function previewRequestFor(url: string, requests: Iterable<RequestView>): RequestView | null {
  const origin = originOf(url);
  if (!origin) return null;
  let best: RequestView | null = null;
  for (const r of requests) {
    if (previewOrigin(r) !== origin) continue;
    // Never treat the production origin itself as a preview.
    if (originOf(r.pageUrl) === origin) continue;
    if (!best || r.updatedAt > best.updatedAt) best = r;
  }
  return best;
}

/** Whether a request's preview is worth opening (built and not merged yet). */
export function hasOpenablePreview(r: RequestView): boolean {
  return !!r.previewUrl && !r.dryRun && !MERGED_STATES.includes(r.state);
}

export type SendMode = "file" | "build";

/** Can a follow-up be sent for this request? Mirrors the Worker's checks. */
export function canFollowUp(r: RequestView): boolean {
  if (r.dryRun || MERGED_STATES.includes(r.state)) return false;
  return r.state === "succeeded" || r.state === "checks_failed" || r.state === "no_changes" || r.state === "failed";
}
