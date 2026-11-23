import type { RequestView } from "@wish/shared";
import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/storage";
import { activeRequests, loadRequests, progressOf, saveRequest, summarize } from "../src/tracking";

const view = (over: Partial<RequestView> = {}): RequestView => ({
  id: "r1",
  clientRequestId: "c1",
  repo: "pnettto/hawk",
  title: "Improve the pricing page",
  pageUrl: "https://e.com/",
  dryRun: false,
  state: "created",
  issueNumber: 142,
  issueUrl: "https://github.com/pnettto/hawk/issues/142",
  runId: null,
  runUrl: null,
  prUrl: null,
  previewUrl: null,
  prNumber: null,
  deployRunUrl: null,
  message: null,
  stalled: false,
  actionsUrl: "https://github.com/pnettto/hawk/actions",
  followupCount: 0,
  awaitingSince: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

describe("tracking", () => {
  it("ignores stale updates and lists active requests", async () => {
    const store = memoryStore();
    await saveRequest(store, view({ state: "running", updatedAt: Date.now() + 10 }));
    await saveRequest(store, view({ state: "started" }));
    const all = await loadRequests(store);
    expect(all.r1?.state).toBe("running");
    expect(activeRequests(all)).toHaveLength(1);
    await saveRequest(store, view({ state: "succeeded", updatedAt: Date.now() + 20 }));
    expect(activeRequests(await loadRequests(store))).toHaveLength(0);
  });

  it("summarises each state", () => {
    expect(summarize(view({ state: "running" })).headline).toBe("Applying changes…");
    expect(summarize(view({ state: "running" })).steps.map((s) => s.label)).toEqual(["Issue created", "Automation started"]);
    expect(summarize(view({ state: "succeeded", previewUrl: "https://p" })).headline).toBe("Changes are ready in a preview.");
    expect(summarize(view({ state: "checks_failed", previewUrl: "https://p" })).headline).toBe("Preview ready, but checks are failing.");
    expect(summarize(view({ state: "untracked", dryRun: true })).headline).toBe("Tracking off (dry run)");
    expect(summarize(view({ state: "created", stalled: true })).tone).toBe("warning");
    expect(summarize(view({ state: "failed" })).tone).toBe("error");
    expect(summarize(view({ state: "integrating", prNumber: 45 })).steps.at(-1)?.label).toBe("PR #45 merged");
    expect(summarize(view({ state: "integrating" })).headline).toBe("Deploying to production…");
    expect(summarize(view({ state: "live" })).headline).toBe("Live in production.");
    expect(summarize(view({ state: "deploy_failed" })).tone).toBe("error");
    expect(summarize(view({ state: "merged", message: "Merged. No production deploy was triggered." })).headline).toBe(
      "Merged. No production deploy was triggered.",
    );
  });
});

describe("refinements", () => {
  it("labels follow-up rounds", () => {
    const s = summarize(view({ state: "running", followupCount: 2 }));
    expect(s.steps[0]?.label).toBe("Refinement 2 sent");
    expect(s.headline).toBe("Applying refinement 2…");
    expect(summarize(view({ state: "succeeded", followupCount: 1 })).steps.at(-1)?.label).toBe("Refinement 1 applied");
  });

  it("reports progress per state", () => {
    expect(progressOf(view({ state: "created" }))).toBeLessThan(progressOf(view({ state: "running" })));
    expect(progressOf(view({ state: "succeeded" }))).toBe(1);
  });
});
