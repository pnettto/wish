import type { RepoInfo } from "@web-issuer/shared";
import type { Draft } from "../drafts";
import type { DockPrefs, Notice, Snapshot } from "../messages";
import { originOf, pageSupport, pathOf, previewRequestFor, productionUrlFor, type SendMode } from "../page";
import type { RequestMap } from "../tracking";

export const RECENT_LIMIT = 8;

/** Inputs for one tab's snapshot (everything already loaded from storage). */
export interface SnapshotInput {
  url: string;
  signedIn: boolean;
  mode: boolean;
  repos: RepoInfo[] | null;
  reposError: string | null;
  draft: Draft | null;
  requests: RequestMap;
  trackByOrigin: Record<string, string>;
  sendModeByRepo: Record<string, SendMode>;
  lastRepo: string | null;
  sending: Snapshot["sending"];
  keptSites: string[];
  notice: Notice | null;
  dockByOrigin: Record<string, DockPrefs>;
  previewNoticeOff: boolean;
  previewNoticeSeen: string[];
}

/** Repo a new draft should use: the last one picked, else the first tracked, else the first. */
export function defaultRepo(repos: RepoInfo[] | null, lastRepo: string | null): string | null {
  if (!repos || repos.length === 0) return lastRepo;
  return (repos.find((r) => r.fullName === lastRepo) ?? repos.find((r) => r.tracked) ?? repos[0]!).fullName;
}

export function buildSnapshot(i: SnapshotInput): Snapshot {
  const origin = originOf(i.url);
  const all = Object.values(i.requests);
  const previewRequest = previewRequestFor(i.url, all);
  const preview = previewRequest
    ? { request: previewRequest, productionUrl: productionUrlFor(previewRequest, pathOf(i.url)) ?? previewRequest.pageUrl }
    : null;
  const trackedId = origin ? i.trackByOrigin[origin] : undefined;
  const request = !preview && trackedId ? (i.requests[trackedId] ?? null) : null;

  let draft = i.draft;
  // Fill in a repo for drafts that don't have a valid one yet.
  if (draft && i.repos && !(draft.repo && i.repos.some((r) => r.fullName === draft!.repo))) {
    draft = { ...draft, repo: defaultRepo(i.repos, i.lastRepo) };
  }
  const repo = draft?.repo ?? defaultRepo(i.repos, i.lastRepo);

  return {
    url: i.url,
    signedIn: i.signedIn,
    support: pageSupport(i.url),
    mode: i.mode,
    repos: i.repos,
    reposError: i.reposError,
    draft,
    request,
    preview,
    sendMode: (repo && i.sendModeByRepo[repo]) || "file",
    sending: i.sending,
    recent: [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_LIMIT),
    firstPreviewNoticeSeen: i.previewNoticeOff || (!!preview && i.previewNoticeSeen.includes(preview.request.id)),
    kept: !!origin && i.keptSites.includes(origin),
    notice: i.notice,
    dock: (origin && i.dockByOrigin[origin]) || null,
  };
}

/** Non-terminal requests a snapshot shows, which the background should follow live. */
export function watchedIds(s: Snapshot): string[] {
  const ids: string[] = [];
  if (s.request) ids.push(s.request.id);
  if (s.preview) ids.push(s.preview.request.id);
  return ids;
}

/** Whether the in-page UI has anything to show for a snapshot. */
export function hasUi(s: Snapshot): boolean {
  return s.mode || !!s.sending || !!s.preview || !!s.request || (s.draft?.annotations.length ?? 0) > 0 || s.kept;
}

