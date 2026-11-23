import { describe, expect, it } from "vitest";
import type { CapturedAnnotation } from "../src/messages";
import { DraftStore, defaultTitle, pageKey } from "../src/drafts";
import { memoryStore } from "../src/storage";

const captured = (comment: string): CapturedAnnotation => ({
  comment,
  locator: "#x",
  tag: "button",
  role: "button",
  kind: "button",
  text: "Upgrade",
  rect: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 1440, height: 900 },
  scroll: { x: 0, y: 0 },
});

function setup() {
  const store = memoryStore();
  let n = 0;
  const drafts = new DraftStore(store, () => `id-${++n}`, () => 1000);
  return { store, drafts };
}

describe("pageKey", () => {
  it("ignores the fragment", () => {
    expect(pageKey("https://e.com/p?a=1#top")).toBe("https://e.com/p?a=1");
  });
});

describe("DraftStore", () => {
  it("creates a draft with a clientRequestId and persists on every change", async () => {
    const { store, drafts } = setup();
    let d = await drafts.loadOrCreate("https://e.com/pricing#x", "Pricing", "pnettto/hawk");
    expect(d.clientRequestId).toBe("id-1");
    expect(store.data.size).toBe(0);

    d = await drafts.addAnnotation(d, captured("Make the upgrade button less prominent"));
    d = await drafts.addAnnotation(d, captured("Explain the usage limit"));
    expect(d.annotations.map((a) => a.id)).toEqual(["id-2", "id-3"]);
    expect(store.data.has("draft:https://e.com/pricing")).toBe(true);

    const restored = await drafts.load("https://e.com/pricing");
    expect(restored).toEqual(d);
    // Reopening keeps the same clientRequestId (idempotent submit).
    expect((await drafts.loadOrCreate("https://e.com/pricing", "Pricing", null)).clientRequestId).toBe("id-1");
  });

  it("edits, deletes and auto-titles until the title is edited", async () => {
    const { drafts } = setup();
    let d = drafts.create("https://e.com/", "Home", null);
    d = await drafts.addAnnotation(d, captured("First line\nmore detail"));
    expect(d.title).toBe("First line");
    d = await drafts.addAnnotation(d, captured("Second"));
    expect(d.title).toBe("First line (+1 more)");

    d = await drafts.updateComment(d, d.annotations[0]!.id, "Changed");
    expect(d.annotations[0]!.comment).toBe("Changed");
    expect(d.title).toBe("Changed (+1 more)");

    d = await drafts.setTitle(d, "My title");
    d = await drafts.removeAnnotation(d, d.annotations[1]!.id);
    expect(d.annotations).toHaveLength(1);
    expect(d.title).toBe("My title");

    d = await drafts.setTitle(d, "");
    expect(d.title).toBe("Changed");
  });

  it("clears only after submit", async () => {
    const { store, drafts } = setup();
    const d = await drafts.addAnnotation(drafts.create("https://e.com/a", "A", null), captured("x"));
    await drafts.addAnnotation(drafts.create("https://e.com/b", "B", null), captured("y"));
    await drafts.clear(d.tabUrl);
    expect([...store.data.keys()]).toEqual(["draft:https://e.com/b"]);
  });

  it("default title falls back to the page title", () => {
    expect(defaultTitle({ annotations: [], pageTitle: "Pricing" })).toBe("Feedback on Pricing");
    expect(defaultTitle({ annotations: [], pageTitle: "" })).toBe("Page feedback");
  });
});
