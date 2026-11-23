import { redactUrl } from "./redact";
import type { Annotation } from "./types";

export const PI_COMMAND_LINE = "/pi Apply the requested changes below.";
export const DRY_RUN_LINE = "> web-issuer dry run: automation not triggered.";
export const MARKER_PREFIX = "<!-- web-issuer:";

export interface IssueBodyInput {
  requestId: string;
  pageUrl: string;
  pageTitle?: string;
  annotations: Annotation[];
  dryRun: boolean;
}

/** Collapse whitespace and keep backticks from breaking inline code. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inlineCode(text: string): string {
  const value = oneLine(text);
  // Use a longer fence if the value itself contains backticks.
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** Neutralise anything that could close the HTML marker comment. */
function safeMarkerId(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, "").replace(/-{2,}/g, "-");
}

function round(n: number): number {
  return Math.round(n);
}

export function formatTarget(a: Annotation): string {
  const kind = oneLine(a.kind || a.role || a.tag || "element");
  const text = oneLine(a.text);
  return text ? `${kind} “${text}”` : kind;
}

export function formatPosition(a: Annotation): string {
  const { rect, viewport } = a;
  return `${round(rect.x)},${round(rect.y)} ${round(rect.width)}×${round(rect.height)} in a ${round(viewport.width)}×${round(viewport.height)} viewport`;
}

export function formatAnnotation(a: Annotation, index: number): string {
  const comment = a.comment.trim().replace(/\r\n?/g, "\n");
  const lines = comment.split("\n");
  const heading = oneLine(lines[0] ?? "") || "(no comment)";
  const out = [`### ${index + 1}. ${heading}`];
  if (lines.length > 1) {
    out.push(comment);
  }
  out.push(`Target: ${formatTarget(a)}`);
  out.push(`Element reference: ${inlineCode(a.locator)}`);
  out.push(`Position: ${formatPosition(a)}`);
  // Markdown hard line breaks are not needed: GitHub renders single newlines
  // inside issues as line breaks.
  return out.join("\n");
}

/** Build the issue body described in PLAN.md §2 and §5.7. */
export function formatIssueBody(input: IssueBodyInput): string {
  const pageUrl = redactUrl(input.pageUrl);
  const pageTitle = oneLine(input.pageTitle ?? "");
  const sections = [
    input.dryRun ? DRY_RUN_LINE : PI_COMMAND_LINE,
    `## Page\n${pageTitle ? `${pageTitle} — ${pageUrl}` : pageUrl}`,
    `## Requested changes\n\n${input.annotations.map(formatAnnotation).join("\n\n")}`,
    `${MARKER_PREFIX}${safeMarkerId(input.requestId)} -->`,
  ];
  return `${sections.join("\n\n")}\n`;
}

/** Extract the request id from an issue body, if present. */
export function parseMarker(body: string): string | null {
  const match = /<!-- web-issuer:([A-Za-z0-9-]+) -->/.exec(body);
  return match?.[1] ?? null;
}
