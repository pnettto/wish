import type { RequestView } from "@web-issuer/shared";
import { h, render } from "preact";
import { describe, expect, it } from "vitest";
import { RequestRow } from "../src/content/app/Dock";
import type { ToBg } from "../src/messages";

const req = (over: Partial<RequestView> = {}): RequestView => ({
  id: "r1",
  clientRequestId: "c1",
  repo: "pnettto/hawk",
  title: "t",
  pageUrl: "https://hawk.example.com/",
  dryRun: false,
  state: "running",
  issueNumber: 7,
  issueUrl: "https://github.com/pnettto/hawk/issues/7",
  runId: 1,
  runUrl: "https://github.com/pnettto/hawk/actions/runs/1",
  prUrl: null,
  previewUrl: null,
  prNumber: null,
  deployRunUrl: null,
  message: null,
  stalled: false,
  actionsUrl: "",
  followupCount: 0,
  awaitingSince: Date.now() - 61_000,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function show(r: RequestView) {
  const el = document.createElement("div");
  const sent: ToBg[] = [];
  render(h(RequestRow, { r, send: (m: ToBg) => sent.push(m), onAddDetail: () => sent.push({ t: "mode", on: true }) }), el);
  return { el, sent };
}

describe("RequestRow", () => {
  it("shows a progress pill while running", () => {
    const { el } = show(req());
    expect(el.textContent).toMatch(/Building…1:0\d/);
    expect(el.querySelectorAll(".seg.on")).toHaveLength(3);
    expect(el.textContent).toContain("View run");
  });

  it("labels refinements", () => {
    expect(show(req({ followupCount: 2 })).el.textContent).toContain("Refining (2)…");
  });

  it("offers the preview when ready and Add detail when it needs attention", () => {
    const ready = show(req({ state: "succeeded", previewUrl: "https://p.pedro-535.workers.dev", prUrl: "https://github.com/x/pull/3", prNumber: 3 }));
    expect(ready.el.textContent).toContain("Preview ready");
    (ready.el.querySelector("button.primary") as HTMLButtonElement).click();
    expect(ready.sent[0]).toMatchObject({ t: "preview.open", requestId: "r1", newTab: false });

    const stuck = show(req({ state: "no_changes", message: "No code changes." }));
    const add = [...stuck.el.querySelectorAll("button")].find((b) => b.textContent === "Add detail")!;
    add.click();
    expect(stuck.sent).toEqual([{ t: "mode", on: true }]);
  });

  it("offers a reload when live and the issue link for dry runs", () => {
    expect(show(req({ state: "live" })).el.textContent).toContain("Reload page");
    expect(show(req({ state: "untracked", dryRun: true })).el.textContent).toContain("Issue #7 filed");
  });
});
