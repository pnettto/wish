/** Lifecycle of one feedback request (one GitHub issue). */
export type RequestState =
  | "creating"
  | "created"
  | "started"
  | "running"
  | "succeeded"
  | "checks_failed"
  | "no_changes"
  | "failed"
  | "untracked";

export const REQUEST_STATES: readonly RequestState[] = [
  "creating",
  "created",
  "started",
  "running",
  "succeeded",
  "checks_failed",
  "no_changes",
  "failed",
  "untracked",
];

/** Outcomes reported by the `**pi:**` comment. */
export type ReportOutcome = "succeeded" | "checks_failed" | "no_changes" | "failed";

/** States after which nothing else is tracked. */
export const TERMINAL_STATES: readonly RequestState[] = [
  "succeeded",
  "checks_failed",
  "no_changes",
  "failed",
  "untracked",
];

export function isTerminalState(state: RequestState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One pinned comment on the page. */
export interface Annotation {
  id: string;
  /** The user's request. May span several lines. */
  comment: string;
  /** Best-effort CSS selector. A hint, not a permanent identifier. */
  locator: string;
  /** Lower-case tag name, e.g. "button". */
  tag: string;
  /** Explicit or implicit ARIA role, if any. */
  role: string | null;
  /** Short human label for the target kind, e.g. "button", "link", "text". */
  kind: string;
  /** Visible-text excerpt, at most 80 characters. Never an input value. */
  text: string;
  /** Bounding rect in viewport coordinates at capture time. */
  rect: Rect;
  viewport: Size;
  scroll: Point;
}

export interface CreateIssueRequest {
  clientRequestId: string;
  /** "owner/name" */
  repo: string;
  title: string;
  pageUrl: string;
  pageTitle?: string;
  annotations: Annotation[];
  dryRun: boolean;
}

/** A request as returned by the Worker API. */
export interface RequestView {
  id: string;
  clientRequestId: string;
  repo: string;
  title: string;
  pageUrl: string;
  dryRun: boolean;
  state: RequestState;
  issueNumber: number | null;
  issueUrl: string | null;
  runId: number | null;
  runUrl: string | null;
  prUrl: string | null;
  previewUrl: string | null;
  message: string | null;
  /** Automation hasn't started 10 minutes after the issue was created. */
  stalled: boolean;
  /** Link to the repo's Actions tab, for the stalled message. */
  actionsUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepoInfo {
  fullName: string;
  /** Whether automation progress is tracked for this repo. */
  tracked: boolean;
}

export interface ReposResponse {
  login: string;
  repos: RepoInfo[];
}

/** Messages pushed over `/requests/:id/live`. */
export type LiveMessage = { type: "state"; request: RequestView };

export interface ApiError {
  error: string;
  message?: string;
}
