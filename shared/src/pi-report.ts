import type { ReportOutcome } from "./types";

export const PI_PREFIX = "**pi:**";

const OUTCOMES: Record<string, ReportOutcome> = {
  "tests and type-check pass.": "succeeded",
  "pushed, but tests or type-check still fail.": "checks_failed",
  "no code changes.": "no_changes",
  "the run failed.": "failed",
};

export interface PiReport {
  outcome: ReportOutcome;
  /** The first line without the `**pi:**` prefix. */
  message: string;
  prUrl: string | null;
  previewUrl: string | null;
  /** The report says "Preview deploy failed." */
  previewFailed: boolean;
  runUrl: string | null;
  runId: number | null;
  /** First ~300 characters of the free-text summary, if any. */
  summary: string | null;
}

const SUMMARY_LIMIT = 300;

export function isPiReport(body: string): boolean {
  return body.trimStart().startsWith(PI_PREFIX);
}

function lineUrl(body: string, label: string): string | null {
  const re = new RegExp(`^[ \\t]*${label}:[ \\t]*<?(https://\\S+?)>?[ \\t]*$`, "mi");
  return re.exec(body)?.[1] ?? null;
}

const KNOWN_LINE = /^[ \t]*(PR:|Preview:|Preview deploy failed\.|Run:)/i;

function extractSummary(rest: string): string | null {
  // The summary is the last paragraph that doesn't hold PR/Preview/Run lines.
  // Stats lines vary in format, so they're skipped when they share a
  // paragraph with the known lines.
  const paragraphs = rest
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const candidates = paragraphs.filter((p) => !p.split("\n").some((line) => KNOWN_LINE.test(line)));
  const last = candidates.at(-1);
  if (!last) return null;
  const text = last.replace(/\s+/g, " ").trim();
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : text;
}

export function runIdFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = /\/actions\/runs\/(\d+)/.exec(url);
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/** Parse a hawk `pi.yml` report comment. Returns null if it isn't one. */
export function parsePiReport(rawBody: string): PiReport | null {
  const body = rawBody.replace(/\r\n?/g, "\n").trimStart();
  if (!body.startsWith(PI_PREFIX)) return null;
  const newline = body.indexOf("\n");
  const firstLine = (newline === -1 ? body : body.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : body.slice(newline + 1);
  const message = firstLine.slice(PI_PREFIX.length).trim();
  const outcome = OUTCOMES[message.toLowerCase()] ?? "failed";
  const runUrl = lineUrl(body, "Run");
  return {
    outcome,
    message: message || firstLine,
    prUrl: lineUrl(body, "PR"),
    previewUrl: lineUrl(body, "Preview"),
    previewFailed: /^[ \t]*Preview deploy failed\./im.test(body),
    runUrl,
    runId: runIdFromUrl(runUrl),
    summary: extractSummary(rest),
  };
}

export function prNumberFromUrl(url: string | null): number | null {
  if (!url) return null;
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}
