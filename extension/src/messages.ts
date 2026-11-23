import type { Annotation, RepoInfo, RequestView } from "@web-issuer/shared";
import type { Draft } from "./drafts";
import type { SendMode, Support } from "./page";

/** Data the picker captures; the background adds the id. */
export type CapturedAnnotation = Omit<Annotation, "id">;

/** Name of the per-tab runtime Port between the content script and the background. */
export const PORT_NAME = "wi";

export interface DockPrefs {
  /** Distance from the viewport's right/bottom edges, px. */
  right: number;
  bottom: number;
  collapsed: boolean;
}

/** Content script → background. */
export type ToBg =
  | { t: "hello"; url: string; title: string }
  | { t: "mode"; on: boolean }
  | { t: "draft.add"; annotation: CapturedAnnotation }
  | { t: "draft.edit"; id: string; comment: string }
  | { t: "draft.remove"; id: string }
  | { t: "draft.setTitle"; title: string }
  | { t: "draft.setRepo"; repo: string }
  | { t: "sendMode"; mode: SendMode }
  /** New issue; the background runs the undo window. */
  | { t: "send"; mode: SendMode }
  /** Follow-up on an existing request using the current draft's comments (also with an undo window). */
  | { t: "followup"; requestId: string }
  | { t: "send.undo" }
  | { t: "integrate"; requestId: string }
  | { t: "preview.open"; requestId: string; newTab: boolean; path: string }
  | { t: "preview.exit" }
  | { t: "preview.swap" }
  | { t: "preview.noticeSeen"; forever: boolean }
  | { t: "request.open"; requestId: string; newTab: boolean }
  | { t: "request.dismiss"; requestId: string }
  | { t: "site.keep"; on: boolean }
  | { t: "settings.open" }
  | { t: "notice.dismiss" }
  | { t: "dock.save"; prefs: DockPrefs }
  | { t: "reload" }
  | { t: "exit" };

/** Background → content script. */
export type ToContent = { t: "snapshot"; s: Snapshot };

export interface Notice {
  text: string;
  tone: "info" | "error";
}

/** Everything the in-page UI needs for one tab. The content app is a pure view of this. */
export interface Snapshot {
  url: string;
  signedIn: boolean;
  support: Support;
  /** Feedback (annotate) mode is on in this tab. */
  mode: boolean;
  repos: RepoInfo[] | null;
  reposError: string | null;
  draft: Draft | null;
  /** Request linked to this page's origin (not set on its own preview; see `preview`). */
  request: RequestView | null;
  /** This tab shows the preview of a tracked request. */
  preview: { request: RequestView; productionUrl: string } | null;
  /** "File issue only" vs "File & build" for the draft's repo. */
  sendMode: SendMode;
  sending: { undoUntil: number; label: string } | null;
  recent: RequestView[];
  firstPreviewNoticeSeen: boolean;
  /** "Keep on for this site" is on. */
  kept: boolean;
  notice: Notice | null;
  dock: DockPrefs | null;
}
