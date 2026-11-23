import type { RequestView } from "@web-issuer/shared";
import { describe, expect, it } from "vitest";
import { buildSnapshot, defaultRepo, hasUi, watchedIds, type SnapshotInput } from "../src/background/state";

const req = (over: Partial<RequestView> = {}): RequestView => ({
  id: "r1",
  clientRequestId: "c1",
  repo: "pnettto/hawk",
  title: "t",
  pageUrl: "https://hawk.example.com/notes",
  dryRun: false,
  state: "running",
  issueNumber: 1,
  issueUrl: null,
  runId: null,
  runUrl: null,
  prUrl: null,
  previewUrl: "https://pi-1.pedro-535.workers.dev",
  prNumber: null,
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

const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  url: "https://hawk.example.com/day?x=1",
  signedIn: true,
  mode: false,
  repos: [
    { fullName: "pnettto/a", tracked: false },
    { fullName: "pnettto/hawk", tracked: true },
  ],
  reposError: null,
  draft: null,
  requests: { r1: req() },
  trackByOrigin: { "https://hawk.example.com": "r1" },
  sendModeByRepo: {},
  lastRepo: null,
  sending: null,
  keptSites: [],
  notice: null,
  dockByOrigin: {},
  previewNoticeOff: false,
  previewNoticeSeen: [],
  ...over,
});

describe("buildSnapshot", () => {
  it("links the request by origin, across paths on the same site", () => {
    const s = buildSnapshot(input());
    expect(s.request?.id).toBe("r1");
    expect(s.preview).toBeNull();
    expect(watchedIds(s)).toEqual(["r1"]);
    expect(hasUi(s)).toBe(true);
    expect(buildSnapshot(input({ url: "https://other.example.com/" })).request).toBeNull();
  });

  it("treats the preview origin as a preview with the production URL for the same path", () => {
    const s = buildSnapshot(input({ url: "https://pi-1.pedro-535.workers.dev/day?x=1" }));
    expect(s.request).toBeNull();
    expect(s.preview?.request.id).toBe("r1");
    expect(s.preview?.productionUrl).toBe("https://hawk.example.com/day?x=1");
    expect(s.firstPreviewNoticeSeen).toBe(false);
    expect(buildSnapshot(input({ url: "https://pi-1.pedro-535.workers.dev/", previewNoticeSeen: ["r1"] })).firstPreviewNoticeSeen).toBe(true);
    expect(buildSnapshot(input({ url: "https://pi-1.pedro-535.workers.dev/", previewNoticeOff: true })).firstPreviewNoticeSeen).toBe(true);
  });

  it("defaults repo and send mode per repo", () => {
    expect(defaultRepo(input().repos, null)).toBe("pnettto/hawk");
    expect(defaultRepo(input().repos, "pnettto/a")).toBe("pnettto/a");
    const s = buildSnapshot(input({ sendModeByRepo: { "pnettto/hawk": "build" } }));
    expect(s.sendMode).toBe("build");
    expect(buildSnapshot(input({ lastRepo: "pnettto/a", sendModeByRepo: { "pnettto/hawk": "build" } })).sendMode).toBe("file");
  });

  it("renders nothing when there's nothing to show", () => {
    expect(hasUi(buildSnapshot(input({ trackByOrigin: {} })))).toBe(false);
    expect(hasUi(buildSnapshot(input({ trackByOrigin: {}, keptSites: ["https://hawk.example.com"] })))).toBe(true);
  });
});
