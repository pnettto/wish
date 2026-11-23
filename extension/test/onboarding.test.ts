import { describe, expect, it } from "vitest";
import { onboardingComplete, onboardingSteps, pickTryTab } from "../src/settings/onboarding";

const base = { signedIn: false, previews: false, previewSkipped: false, triedIt: false };
const statuses = (i: Partial<typeof base>) => onboardingSteps({ ...base, ...i }).map((s) => s.status);

describe("onboardingSteps", () => {
  it("unlocks steps in order", () => {
    expect(statuses({})).toEqual(["current", "locked", "locked"]);
    expect(statuses({ signedIn: true })).toEqual(["done", "current", "locked"]);
    expect(statuses({ signedIn: true, previews: true })).toEqual(["done", "done", "current"]);
    expect(statuses({ signedIn: true, previewSkipped: true })).toEqual(["done", "skipped", "current"]);
  });

  it("marks steps done even when done out of order", () => {
    expect(statuses({ previews: true, triedIt: true })).toEqual(["current", "done", "done"]);
  });

  it("is complete when everything is done or skipped", () => {
    expect(onboardingComplete(onboardingSteps({ ...base, signedIn: true, previewSkipped: true, triedIt: true }))).toBe(true);
    expect(onboardingComplete(onboardingSteps({ ...base, signedIn: true, previews: true }))).toBe(false);
  });
});

describe("pickTryTab", () => {
  it("picks the most recent http(s) tab", () => {
    const tabs = [
      { id: 1, url: "https://a.example/", lastAccessed: 5 },
      { id: 2, url: "chrome-extension://x/settings/index.html", lastAccessed: 9 },
      { id: 3, url: "http://b.example/", lastAccessed: 7 },
      { id: 4, url: "chrome://extensions", lastAccessed: 8 },
    ];
    expect(pickTryTab(tabs)?.id).toBe(3);
    expect(pickTryTab([{ id: 1, url: "chrome://newtab" }])).toBeUndefined();
  });
});
