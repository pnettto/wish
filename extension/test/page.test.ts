import type { RequestView } from "@web-issuer/shared";
import { describe, expect, it } from "vitest";
import {
  canFollowUp,
  matchesPattern,
  originPattern,
  pageSupport,
  pathOf,
  previewRequestFor,
  previewUrlFor,
  productionUrlFor,
} from "../src/page";

const view = (over: Partial<RequestView> = {}): RequestView => ({
  id: "r1",
  clientRequestId: "c1",
  repo: "pnettto/hawk",
  title: "t",
  pageUrl: "https://hawk.example.com/notes?x=1",
  dryRun: false,
  state: "succeeded",
  issueNumber: 44,
  issueUrl: null,
  runId: null,
  runUrl: null,
  prUrl: "https://github.com/pnettto/hawk/pull/45",
  previewUrl: "https://pi-issue-44-hawk.pedro-535.workers.dev",
  prNumber: 45,
  deployRunUrl: null,
  message: null,
  stalled: false,
  actionsUrl: "",
  followupCount: 0,
  awaitingSince: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("preview URL mapping", () => {
  const loc = pathOf("https://hawk.example.com/day/2026-11-23?tab=tasks#top");

  it("keeps path, query and hash in both directions", () => {
    expect(previewUrlFor(view(), loc)).toBe("https://pi-issue-44-hawk.pedro-535.workers.dev/day/2026-11-23?tab=tasks#top");
    expect(productionUrlFor(view(), pathOf("https://pi-issue-44-hawk.pedro-535.workers.dev/a?b=1"))).toBe("https://hawk.example.com/a?b=1");
    expect(previewUrlFor(view({ previewUrl: null }), loc)).toBeNull();
  });

  it("finds the request a preview origin belongs to (latest wins, never production)", () => {
    const a = view({ id: "a", updatedAt: 1 });
    const b = view({ id: "b", updatedAt: 5 });
    const other = view({ id: "c", previewUrl: "https://other.pedro-535.workers.dev" });
    expect(previewRequestFor("https://pi-issue-44-hawk.pedro-535.workers.dev/x", [a, b, other])?.id).toBe("b");
    expect(previewRequestFor("https://hawk.example.com/x", [a, b])).toBeNull();
    const self = view({ previewUrl: "https://hawk.example.com" });
    expect(previewRequestFor("https://hawk.example.com/", [self])).toBeNull();
  });
});

describe("match patterns", () => {
  it("handles wildcard subdomains and ignores ports", () => {
    expect(matchesPattern("https://pi-issue-44-hawk.pedro-535.workers.dev/x", "https://*.pedro-535.workers.dev/*")).toBe(true);
    expect(matchesPattern("https://evil.dev/?pedro-535.workers.dev", "https://*.pedro-535.workers.dev/*")).toBe(false);
    expect(matchesPattern("http://pi.pedro-535.workers.dev/", "https://*.pedro-535.workers.dev/*")).toBe(false);
    expect(matchesPattern("http://127.0.0.1:5173/a", "http://127.0.0.1/*")).toBe(true);
    expect(originPattern("http://127.0.0.1:5173")).toBe("http://127.0.0.1/*");
  });
});

describe("pageSupport / canFollowUp", () => {
  it("explains unsupported pages", () => {
    expect(pageSupport("chrome://extensions").ok).toBe(false);
    expect(pageSupport("https://e.com/a.pdf").ok).toBe(false);
    expect(pageSupport("https://e.com/").ok).toBe(true);
  });

  it("only refines finished, unmerged, non-dry-run requests", () => {
    expect(canFollowUp(view())).toBe(true);
    expect(canFollowUp(view({ state: "no_changes" }))).toBe(true);
    expect(canFollowUp(view({ state: "running" }))).toBe(false);
    expect(canFollowUp(view({ state: "live" }))).toBe(false);
    expect(canFollowUp(view({ dryRun: true, state: "untracked" }))).toBe(false);
  });
});
