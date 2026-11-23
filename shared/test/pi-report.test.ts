import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPiReport, parsePiReport, runIdFromUrl } from "../src/pi-report";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../worker/test/fixtures/reports/${name}.md`, import.meta.url)), "utf8");

const RUN = "https://github.com/pnettto/hawk/actions/runs/1234567890";
const PR = "https://github.com/pnettto/hawk/pull/143";

describe("parsePiReport", () => {
  it("parses a success report", () => {
    expect(parsePiReport(fixture("succeeded"))).toEqual({
      outcome: "succeeded",
      message: "tests and type-check pass.",
      prUrl: PR,
      previewUrl: "https://hawk-pi-issue-142.example.workers.dev",
      previewFailed: false,
      runUrl: RUN,
      runId: 1234567890,
      summary: "Made the upgrade button secondary and added a tooltip explaining usage limits.",
    });
  });

  it("parses checks_failed with a failed preview", () => {
    const r = parsePiReport(fixture("checks_failed"));
    expect(r).toMatchObject({ outcome: "checks_failed", prUrl: PR, previewUrl: null, previewFailed: true, runId: 1234567890, summary: null });
  });

  it("parses no_changes", () => {
    expect(parsePiReport(fixture("no_changes"))).toMatchObject({ outcome: "no_changes", prUrl: null, previewUrl: null, runUrl: RUN });
  });

  it("parses failed", () => {
    expect(parsePiReport(fixture("failed"))).toMatchObject({ outcome: "failed", runUrl: RUN, message: "the run failed." });
  });

  it("parses the PR copy (no PR line)", () => {
    expect(parsePiReport(fixture("pr-copy"))).toMatchObject({ outcome: "succeeded", prUrl: null, previewUrl: "https://hawk-pi-issue-142.example.workers.dev" });
  });

  it("treats an unknown first line as failed with the raw message", () => {
    expect(parsePiReport(fixture("unknown"))).toMatchObject({ outcome: "failed", message: "something new happened.", runId: 1234567890 });
  });

  it("is tolerant of CRLF, leading whitespace and odd preview hosts", () => {
    const r = parsePiReport("\n  **pi:** tests and type-check pass.\r\n\r\nPreview:   https://hawk-abc123-pi-issue-7.someone.workers.dev/  \r\nRun: <https://github.com/o/r/actions/runs/42>\r\n");
    expect(r).toMatchObject({ outcome: "succeeded", previewUrl: "https://hawk-abc123-pi-issue-7.someone.workers.dev/", runId: 42 });
  });

  it("ignores URLs that aren't on their own labelled line", () => {
    const r = parsePiReport("**pi:** no code changes.\n\nSee PR: https://evil.example/x for details");
    expect(r?.prUrl).toBeNull();
  });

  it("truncates long summaries", () => {
    const r = parsePiReport(`**pi:** tests and type-check pass.\n\n${"word ".repeat(200)}`);
    expect(r?.summary?.length).toBeLessThanOrEqual(300);
    expect(r?.summary?.endsWith("…")).toBe(true);
  });

  it("returns null for other comments", () => {
    expect(parsePiReport("LGTM")).toBeNull();
    expect(isPiReport("pi: nope")).toBe(false);
    expect(isPiReport(" **pi:** x")).toBe(true);
  });
});

describe("runIdFromUrl", () => {
  it("extracts the run id", () => {
    expect(runIdFromUrl(RUN)).toBe(1234567890);
    expect(runIdFromUrl(`${RUN}/job/5`)).toBe(1234567890);
    expect(runIdFromUrl("https://example.com")).toBeNull();
    expect(runIdFromUrl(null)).toBeNull();
  });
});
