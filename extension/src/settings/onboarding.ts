/** Guided first-run order on the settings page: Connect → Allow preview sites → Try it. */

export type StepId = "connect" | "previews" | "try";
export type StepStatus = "done" | "skipped" | "current" | "locked";

export interface OnboardingInput {
  signedIn: boolean;
  /** null while the permission check is pending. */
  previews: boolean | null;
  previewSkipped: boolean;
  triedIt: boolean;
}

export interface Step {
  id: StepId;
  status: StepStatus;
}

export function onboardingSteps(i: OnboardingInput): Step[] {
  const raw: [StepId, StepStatus | null][] = [
    ["connect", i.signedIn ? "done" : null],
    ["previews", i.previews ? "done" : i.previewSkipped ? "skipped" : null],
    ["try", i.triedIt ? "done" : null],
  ];
  let current = false;
  return raw.map(([id, s]) => {
    if (s) return { id, status: s };
    const status: StepStatus = current ? "locked" : "current";
    current = true;
    return { id, status };
  });
}

/** Show the checklist until every step is done or skipped. */
export function onboardingComplete(steps: Step[]): boolean {
  return steps.every((s) => s.status === "done" || s.status === "skipped");
}

/** Most recently used regular web tab (where "Try it" should send the user). */
export function pickTryTab<T extends { url?: string; lastAccessed?: number; id?: number }>(tabs: T[]): T | undefined {
  return tabs
    .filter((t) => t.id !== undefined && /^https?:\/\//.test(t.url ?? "") && !/^https:\/\/chromewebstore\.google\.com\//.test(t.url ?? ""))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}
