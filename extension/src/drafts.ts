import type { Annotation } from "@wish/shared";
import type { CapturedAnnotation } from "./messages";
import { KEYS, type KeyValueStore } from "./storage";

export interface Draft {
  /** Generated when the draft is created; makes submission idempotent. */
  clientRequestId: string;
  tabUrl: string;
  pageTitle: string;
  repo: string | null;
  title: string;
  /** True once the user edited the title (stop auto-filling it). */
  titleEdited: boolean;
  annotations: Annotation[];
  createdAt: number;
  updatedAt: number;
}

/** Drafts are keyed by URL without the fragment. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url.split("#")[0] ?? url;
  }
}

export function defaultTitle(draft: Pick<Draft, "annotations" | "pageTitle">): string {
  const first = draft.annotations[0]?.comment.split("\n")[0]?.trim();
  if (first) {
    const base = first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first;
    return draft.annotations.length > 1 ? `${base} (+${draft.annotations.length - 1} more)` : base;
  }
  return draft.pageTitle ? `Feedback on ${draft.pageTitle}` : "Page feedback";
}

export class DraftStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(tabUrl: string): Promise<Draft | undefined> {
    return this.store.get<Draft>(KEYS.draft(pageKey(tabUrl)));
  }

  create(tabUrl: string, pageTitle: string, repo: string | null): Draft {
    const now = this.now();
    return {
      clientRequestId: this.newId(),
      tabUrl,
      pageTitle,
      repo,
      title: "",
      titleEdited: false,
      annotations: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async save(draft: Draft): Promise<Draft> {
    const next = { ...draft, updatedAt: this.now() };
    if (!next.titleEdited) next.title = defaultTitle(next);
    await this.store.set(KEYS.draft(pageKey(draft.tabUrl)), next);
    return next;
  }

  async clear(tabUrl: string): Promise<void> {
    await this.store.remove(KEYS.draft(pageKey(tabUrl)));
  }

  async loadOrCreate(tabUrl: string, pageTitle: string, repo: string | null): Promise<Draft> {
    return (await this.load(tabUrl)) ?? this.create(tabUrl, pageTitle, repo);
  }

  addAnnotation(draft: Draft, captured: CapturedAnnotation): Promise<Draft> {
    const annotation: Annotation = { ...captured, id: this.newId() };
    return this.save({ ...draft, annotations: [...draft.annotations, annotation] });
  }

  updateComment(draft: Draft, id: string, comment: string): Promise<Draft> {
    return this.save({
      ...draft,
      annotations: draft.annotations.map((a) => (a.id === id ? { ...a, comment } : a)),
    });
  }

  removeAnnotation(draft: Draft, id: string): Promise<Draft> {
    return this.save({ ...draft, annotations: draft.annotations.filter((a) => a.id !== id) });
  }

  setTitle(draft: Draft, title: string): Promise<Draft> {
    return this.save({ ...draft, title, titleEdited: title.trim() !== "" });
  }

  setRepo(draft: Draft, repo: string): Promise<Draft> {
    return this.save({ ...draft, repo });
  }
}
