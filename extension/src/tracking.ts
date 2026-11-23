import { isTerminalState, type RequestView } from "@web-issuer/shared";
import { KEYS, type KeyValueStore } from "./storage";

export type RequestMap = Record<string, RequestView>;

export async function loadRequests(store: KeyValueStore): Promise<RequestMap> {
  return (await store.get<RequestMap>(KEYS.requests)) ?? {};
}

/** Store the latest view of a request, ignoring stale updates. */
export async function saveRequest(store: KeyValueStore, view: RequestView): Promise<RequestMap> {
  const all = await loadRequests(store);
  const prev = all[view.id];
  if (prev && prev.updatedAt > view.updatedAt) return all;
  all[view.id] = view;
  // Keep storage small: drop finished requests older than a week.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [id, r] of Object.entries(all)) {
    if (isTerminalState(r.state) && r.updatedAt < cutoff) delete all[id];
  }
  await store.set(KEYS.requests, all);
  return all;
}

export function activeRequests(all: RequestMap): RequestView[] {
  return Object.values(all).filter((r) => !isTerminalState(r.state));
}

export interface Step {
  label: string;
  done: boolean;
}

export interface StatusSummary {
  steps: Step[];
  /** Current activity or outcome text. */
  headline: string | null;
  tone: "neutral" | "success" | "warning" | "error";
}

export function summarize(r: RequestView): StatusSummary {
  const created: Step = { label: "Issue created", done: true };
  const started: Step = { label: "Automation started", done: true };
  switch (r.state) {
    case "creating":
      return { steps: [], headline: "Creating issue…", tone: "neutral" };
    case "untracked":
      return {
        steps: [created],
        headline: r.dryRun ? "Tracking off (dry run)" : "Tracking off for this repository",
        tone: "neutral",
      };
    case "created":
      return r.stalled
        ? { steps: [created], headline: "Automation hasn't started", tone: "warning" }
        : { steps: [created], headline: "Waiting for automation…", tone: "neutral" };
    case "started":
      return { steps: [created, started], headline: "Starting…", tone: "neutral" };
    case "running":
      return { steps: [created, started], headline: "Applying changes…", tone: "neutral" };
    case "succeeded":
      return {
        steps: [created, started, { label: "Changes applied", done: true }],
        headline: r.previewUrl ? "Changes are ready in a preview." : "Changes are ready in a pull request.",
        tone: "success",
      };
    case "checks_failed":
      return {
        steps: [created, started, { label: "Changes pushed", done: true }],
        headline: r.previewUrl ? "Preview ready, but checks are failing." : "Changes pushed, but checks are failing.",
        tone: "warning",
      };
    case "no_changes":
      return { steps: [created, started], headline: "No code changes were made. The request may need more detail.", tone: "warning" };
    case "failed":
      return { steps: [created, started], headline: "The automation failed.", tone: "error" };
  }
}
