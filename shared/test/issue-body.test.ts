import { describe, expect, it } from "vitest";
import { formatFollowupBody, formatIssueBody, parseMarker } from "../src/issue-body";
import type { Annotation } from "../src/types";

const base: Omit<Annotation, "id" | "comment" | "locator" | "kind" | "text" | "rect" | "tag"> = {
  role: null,
  viewport: { width: 1440, height: 900 },
  scroll: { x: 0, y: 0 },
};

const annotations: Annotation[] = [
  {
    ...base,
    id: "a1",
    comment: "Make the upgrade button less prominent",
    tag: "button",
    role: "button",
    kind: "button",
    text: "Upgrade",
    locator: "#pricing .card:nth-of-type(2) button",
    rect: { x: 912, y: 184, width: 120, height: 40 },
  },
  {
    ...base,
    id: "a2",
    comment: "Explain what the usage limit includes",
    tag: "span",
    kind: "text",
    text: "10,000 requests",
    locator: '[data-testid="usage-limit"]',
    rect: { x: 640.4, y: 419.6, width: 180, height: 24 },
  },
];

const ID = "6f1c2c1e-0d7e-4a52-9a43-5b3f6f0f8a11";

describe("formatIssueBody", () => {
  it("matches the PLAN §2 example", () => {
    const body = formatIssueBody({
      requestId: ID,
      pageUrl: "https://example.com/pricing",
      pageTitle: "Pricing",
      annotations,
      dryRun: false,
    });
    expect(body).toBe(`/pi Apply the requested changes below.

## Page
Pricing — https://example.com/pricing

## Requested changes

### 1. Make the upgrade button less prominent
Target: button “Upgrade”
Element reference: \`#pricing .card:nth-of-type(2) button\`
Position: 912,184 120×40 in a 1440×900 viewport

### 2. Explain what the usage limit includes
Target: text “10,000 requests”
Element reference: \`[data-testid="usage-limit"]\`
Position: 640,420 180×24 in a 1440×900 viewport

<!-- web-issuer:${ID} -->
`);
    expect(body.startsWith("/pi")).toBe(true);
    expect(parseMarker(body)).toBe(ID);
  });

  it("uses the dry-run notice instead of /pi", () => {
    const body = formatIssueBody({ requestId: ID, pageUrl: "https://example.com/", annotations, dryRun: true });
    expect(body.split("\n")[0]).toBe("> web-issuer dry run: automation not triggered.");
    expect(body).not.toMatch(/^\/pi/m);
    expect(body).toContain("## Page\nhttps://example.com/\n");
  });

  it("includes the full comment when it has several lines", () => {
    const body = formatIssueBody({
      requestId: ID,
      pageUrl: "https://example.com/",
      annotations: [{ ...annotations[0]!, comment: "Smaller button\r\nAnd use the muted colour." }],
      dryRun: false,
    });
    expect(body).toContain("### 1. Smaller button\nSmaller button\nAnd use the muted colour.\nTarget: button “Upgrade”");
  });

  it("redacts the page URL", () => {
    const body = formatIssueBody({
      requestId: ID,
      pageUrl: "https://example.com/p?token=abc&x=1#secret",
      annotations,
      dryRun: false,
    });
    expect(body).toContain("https://example.com/p?token=REDACTED&x=1\n");
    expect(body).not.toContain("abc");
    expect(body).not.toContain("#secret");
  });

  it("omits the quoted text when there is none and escapes backticks", () => {
    const body = formatIssueBody({
      requestId: ID,
      pageUrl: "https://example.com/",
      annotations: [{ ...annotations[0]!, text: "", kind: "img", locator: "a[title=`x`]" }],
      dryRun: false,
    });
    expect(body).toContain("Target: img\n");
    expect(body).toContain("Element reference: ``a[title=`x`]``");
  });

  it("sanitises the marker id", () => {
    const body = formatIssueBody({ requestId: "abc --> <b>", pageUrl: "https://e.com/", annotations, dryRun: false });
    expect(body).toContain("<!-- web-issuer:abc-b -->");
  });
});

describe("formatFollowupBody", () => {
  it("starts with /pi, links the (redacted) preview page and keeps its own marker", () => {
    const body = formatFollowupBody({
      followupId: "f-1",
      pageUrl: "https://pi-issue-142-hawk.pedro-535.workers.dev/pricing?token=abc#x",
      pageTitle: "Pricing",
      annotations: [annotations[1]!],
    });
    expect(body).toBe(`/pi Apply the follow-up changes below.

## Page
Pricing — https://pi-issue-142-hawk.pedro-535.workers.dev/pricing?token=REDACTED

## Requested changes

### 1. Explain what the usage limit includes
Target: text “10,000 requests”
Element reference: \`[data-testid="usage-limit"]\`
Position: 640,420 180×24 in a 1440×900 viewport

<!-- web-issuer-followup:f-1 -->
`);
    // Not mistaken for the issue's own marker.
    expect(parseMarker(body)).toBeNull();
  });
});
