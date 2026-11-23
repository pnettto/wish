// Playwright tests for the in-page UI (dist/content.js). A fake background
// (fake-background.js) answers the content script's Port with Snapshots, so
// these cover the content side end to end without Chrome extension APIs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("@playwright/test"));
}

const fixture = readFileSync(fileURLToPath(new URL("./fixture.html", import.meta.url)));
const contentScript = fileURLToPath(new URL("../../dist/content.js", import.meta.url));
const fakeBackground = readFileSync(fileURLToPath(new URL("./fake-background.js", import.meta.url)), "utf8");

let servers = [];
let browser;
let prodUrl;
let previewOrigin;

function serve() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fixture);
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}

before(async () => {
  prodUrl = `${await serve()}/pricing?session=abc`;
  // Second origin plays the preview deployment.
  previewOrigin = (await serve()).replace("127.0.0.1", "localhost");
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox"],
  });
});

after(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

async function openPage(url = prodUrl, initial = {}, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(
    ([init, undoMs]) => {
      window.__initialSnapshot = init;
      window.__undoMs = undoMs;
    },
    [initial, opts.undoMs ?? 5000],
  );
  await page.addInitScript(fakeBackground);
  await page.goto(url);
  await page.addScriptTag({ path: contentScript });
  return page;
}

const ui = (page, sel) => page.locator(`wish-overlay ${sel}`);
const sent = (page) => page.evaluate(() => window.__sent);
const lastOf = async (page, t) => (await sent(page)).filter((m) => m.t === t).at(-1);
/** Wait for the next message of type `t` (messages reach the fake background asynchronously). */
async function nextOf(page, t, action) {
  const before = (await sent(page)).filter((m) => m.t === t).length;
  await action();
  await page.waitForFunction(([type, n]) => window.__sent.filter((m) => m.t === type).length > n, [t, before]);
  return lastOf(page, t);
}

test("renders nothing until there's something to show", async () => {
  const page = await openPage();
  await page.waitForFunction(() => window.__sent.some((m) => m.t === "hello"));
  assert.equal(await ui(page, ".dock").count(), 0);
  // Page works normally.
  await page.click("#upgrade");
  assert.equal(await page.evaluate(() => window.pageClicks), 1);
  await page.close();
});

test("annotate: hover label, traversal, Alt-click, pins edit/delete, Escape", async () => {
  const page = await openPage(prodUrl, { mode: true });
  await ui(page, ".dock").waitFor();
  assert.match(await ui(page, ".dock").innerText(), /Click anything to comment/);

  // Hover → outline + label.
  await page.hover("#upgrade");
  const button = await page.locator("#upgrade").boundingBox();
  const outline = await ui(page, ".outline").boundingBox();
  assert.ok(Math.abs(outline.x - (button.x - 2)) < 1.5, "outline aligned");
  assert.match(await ui(page, ".hover-label").innerText(), /^button "Upgrade" · \d+×\d+$/);

  // ↑ selects the parent card, ↓ goes back down.
  await page.keyboard.press("ArrowUp");
  assert.match(await ui(page, ".hover-label").innerText(), /^div /);
  await page.keyboard.press("ArrowDown");
  assert.match(await ui(page, ".hover-label").innerText(), /^heading "Pro"/);

  // Alt-click reaches the page; a plain click doesn't.
  await page.click("#upgrade", { modifiers: ["Alt"] });
  assert.equal(await page.evaluate(() => window.pageClicks), 1);
  await page.click("#upgrade");
  assert.equal(await page.evaluate(() => window.pageClicks), 1, "click swallowed in feedback mode");

  // Comment popover → saved annotation.
  await ui(page, ".popover textarea").waitFor();
  assert.equal(await ui(page, ".pin.draft").innerText(), "1");
  await page.keyboard.type("Make the upgrade button less prominent");
  const add = await nextOf(page, "draft.add", () => page.keyboard.press("Control+Enter"));
  await ui(page, ".popover").waitFor({ state: "detached" });
  assert.equal(add.annotation.comment, "Make the upgrade button less prominent");
  assert.equal(add.annotation.locator, "#upgrade");
  assert.equal(add.annotation.text, "Upgrade");
  assert.deepEqual(add.annotation.viewport, { width: 1280, height: 800 });

  // Pin at the target's top-right; dock counts it.
  const pin = await ui(page, 'button.pin[data-number="1"]').boundingBox();
  assert.ok(Math.abs(pin.x + pin.width / 2 - (button.x + button.width)) < 2, "pin at top-right");
  assert.match(await ui(page, ".dock").innerText(), /1 comment/);

  // Second comment: an input never leaks its value.
  await page.click("#email");
  await page.keyboard.type("Clarify this label");
  await ui(page, ".popover button.primary").click();
  await page.waitForFunction(() => window.__state.draft?.annotations.length === 2);
  assert.ok(!JSON.stringify(await sent(page)).includes("secret"), "input value not captured");

  // Pin hover → tooltip; click → edit in place.
  await ui(page, 'button.pin[data-number="1"]').hover();
  assert.match(await ui(page, ".tooltip").innerText(), /less prominent/);
  await ui(page, 'button.pin[data-number="1"]').click();
  await ui(page, ".popover textarea").fill("Make it secondary");
  await ui(page, ".popover button.primary").click();
  await page.waitForFunction(() => window.__state.draft.annotations[0].comment === "Make it secondary");

  // …and delete.
  await ui(page, 'button.pin[data-number="2"]').click();
  await ui(page, ".popover .danger-link").click();
  await page.waitForFunction(() => window.__state.draft.annotations.length === 1);

  // Detached pin when the element disappears.
  await page.evaluate(() => document.getElementById("upgrade").remove());
  await ui(page, ".pin.detached").waitFor();

  // Escape: closes a popover first, then leaves feedback mode.
  await page.click('[data-testid="usage-limit"]');
  await ui(page, ".popover").waitFor();
  await page.keyboard.press("Escape");
  await ui(page, ".popover").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__state.mode), true);
  await page.mouse.move(5, 5);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__state.mode === false);
  assert.equal(await ui(page, ".outline").count(), 0);

  // Re-injection reuses the instance.
  await page.addScriptTag({ path: contentScript });
  assert.equal(await page.evaluate(() => document.querySelectorAll("wish-overlay").length), 1);
  await page.close();
});

test("keyboard only: pick, comment, compose, send with undo", async () => {
  const page = await openPage(prodUrl, { mode: true }, { undoMs: 1500 });
  await ui(page, ".dock").waitFor();

  // Tab focuses page elements; Enter comments on the highlighted one.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.match(await ui(page, ".hover-label").innerText(), /^button "Upgrade"/);
  await page.keyboard.press("Enter");
  await ui(page, ".popover textarea").waitFor();
  await page.keyboard.type("Less prominent");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => window.__state.draft?.annotations.length === 1);

  // ⌘/Ctrl+Enter opens the composer (title focused), again sends.
  await page.keyboard.press("Control+Enter");
  await ui(page, ".composer").waitFor();
  assert.equal(await ui(page, ".title-input").inputValue(), "Less prominent");
  assert.equal(await ui(page, '.segmented [aria-checked="true"]').innerText(), "File issue only");
  await page.keyboard.press("Control+Enter");
  await ui(page, ".sending").waitFor();
  assert.deepEqual(await lastOf(page, "send"), { t: "send", mode: "file" });

  // Undo returns to the composer with the draft intact.
  await ui(page, ".sending button").click();
  await ui(page, ".composer").waitFor();
  assert.equal(await page.evaluate(() => window.__state.draft.annotations.length), 1);

  // File & build, send, wait out the undo window.
  await ui(page, '.segmented [role="radio"]:has-text("File & build")').click();
  await ui(page, '.composer button[type="submit"]').click();
  await ui(page, ".sending").waitFor();
  await ui(page, ".progress").waitFor({ timeout: 5000 });
  assert.deepEqual(await lastOf(page, "send"), { t: "send", mode: "build" });
  assert.equal(await ui(page, ".pin").count(), 0, "pins cleared after send");
  assert.match(await ui(page, ".progress").innerText(), /Building…/);
  await page.close();
});

test("progress pill follows request updates; ready offers the preview", async () => {
  const t = Date.now();
  const req = {
    id: "r1", clientRequestId: "c1", repo: "pnettto/hawk", title: "Tighten header", pageUrl: prodUrl, dryRun: false, state: "created",
    issueNumber: 142, issueUrl: "https://github.com/pnettto/hawk/issues/142", runId: null, runUrl: null, prUrl: null, previewUrl: null,
    prNumber: null, deployRunUrl: null, message: null, stalled: false, actionsUrl: "https://github.com/pnettto/hawk/actions",
    followupCount: 0, awaitingSince: t - 134_000, createdAt: t - 134_000, updatedAt: t,
  };
  const page = await openPage(prodUrl, { request: req });
  await ui(page, ".progress").waitFor();
  assert.match(await ui(page, ".progress").innerText(), /Building…\s*2:1\d/);
  assert.equal(await ui(page, ".seg.on").count(), 1);

  await page.evaluate((r) => window.__push({ request: { ...r, state: "running", runUrl: "https://github.com/x/actions/runs/1" } }), req);
  await page.waitForFunction(() => document.querySelector("wish-overlay").shadowRoot.querySelectorAll(".seg.on").length === 3);
  assert.match(await ui(page, ".req").innerText(), /Applying changes/);

  await page.evaluate(
    ([r, p]) => window.__push({ request: { ...r, state: "succeeded", prUrl: "https://github.com/pnettto/hawk/pull/143", prNumber: 143, previewUrl: p } }),
    [req, previewOrigin],
  );
  const open = await nextOf(page, "preview.open", () => ui(page, '.req button:has-text("Open preview")').click());
  assert.deepEqual(open, { t: "preview.open", requestId: "r1", newTab: false, path: "/pricing?session=abc" });

  // Needs attention → Add detail turns on a follow-up composer for the same request.
  await page.evaluate((r) => window.__push({ request: { ...r, state: "no_changes", message: "No code changes." } }), req);
  await ui(page, '.req button:has-text("Add detail")').click();
  await page.waitForFunction(() => window.__state.mode === true);
  assert.match(await ui(page, ".dock").innerText(), /Click what should change/);
  await page.close();
});

test("preview: notice, banner, title prefix, swap, merge confirm, follow-up", async () => {
  const t = Date.now();
  const request = {
    id: "r1", clientRequestId: "c1", repo: "pnettto/hawk", title: "Tighten header spacing", pageUrl: prodUrl, dryRun: false,
    state: "succeeded", issueNumber: 142, issueUrl: "https://github.com/pnettto/hawk/issues/142", runId: 1, runUrl: "https://x/runs/1",
    prUrl: "https://github.com/pnettto/hawk/pull/12", previewUrl: previewOrigin, prNumber: 12, deployRunUrl: null, message: null,
    stalled: false, actionsUrl: "https://github.com/pnettto/hawk/actions", followupCount: 0, awaitingSince: t, createdAt: t, updatedAt: t,
  };
  const productionUrl = prodUrl.replace(/\?.*/, "") + "?session=abc";
  const page = await openPage(`${previewOrigin}/pricing?session=abc`, {
    preview: { request, productionUrl },
    firstPreviewNoticeSeen: false,
  }, { undoMs: 300 });

  // First-time notice.
  await ui(page, ".modal").waitFor();
  assert.match(await ui(page, ".modal").innerText(), /looking at a preview.*PR #12/s);
  await ui(page, ".modal input[type=checkbox]").check();
  assert.deepEqual(await nextOf(page, "preview.noticeSeen", () => ui(page, '.modal button:has-text("Got it")').click()), {
    t: "preview.noticeSeen",
    forever: true,
  });
  await ui(page, ".modal").waitFor({ state: "detached" });

  // Banner + title prefix.
  const banner = ui(page, ".banner");
  assert.match(await banner.innerText(), /PREVIEW\s*PR #12 “Tighten header spacing” · not live/);
  assert.equal(await page.title(), "[Preview] Pricing");
  const box = await banner.boundingBox();
  assert.equal(box.y, 0);

  assert.deepEqual(await nextOf(page, "preview.swap", () => ui(page, '.banner button:has-text("Live ⇄ Preview")').click()), { t: "preview.swap" });

  // Merge asks for confirmation first.
  await ui(page, '.banner button:has-text("Merge & deploy")').click();
  assert.match(await ui(page, ".confirm").innerText(), /squash-merges PR #12/);
  assert.equal(await lastOf(page, "integrate"), undefined);
  assert.deepEqual(await nextOf(page, "integrate", () => ui(page, '.confirm button:has-text("Merge and deploy")').click()), {
    t: "integrate",
    requestId: "r1",
  });

  // Feedback on the preview becomes a follow-up to the same PR.
  await page.evaluate(() => window.__push({ mode: true }));
  await page.click("h2 >> nth=0");
  await page.keyboard.type("More space under the header");
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => window.__state.draft?.annotations.length === 1);
  await page.keyboard.press("Control+Enter");
  assert.match(await ui(page, '.composer button[type="submit"]').innerText(), /Send to PR #12/);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => window.__sent.some((m) => m.t === "followup"));
  assert.deepEqual(await lastOf(page, "followup"), { t: "followup", requestId: "r1" });
  await page.waitForFunction(() => window.__state.preview.request.state === "created");
  assert.match(await banner.innerText(), /Refinement 1 in progress/);

  // Exit restores the title.
  await page.evaluate(() => window.__push({ preview: null }));
  await page.waitForFunction(() => document.title === "Pricing");
  await page.close();
});

test("collapse, shortcuts sheet, not signed in", async () => {
  const page = await openPage(prodUrl, { mode: true, signedIn: false });
  await ui(page, ".dock").waitFor();
  assert.match(await ui(page, ".dock").innerText(), /Connect GitHub/);
  await page.evaluate(() => window.__push({ signedIn: true }));
  await page.mouse.move(5, 5);
  await page.keyboard.press("?");
  await ui(page, '.modal[aria-label="Keyboard shortcuts"]').waitFor();
  await page.keyboard.press("Escape");
  await ui(page, ".modal").waitFor({ state: "detached" });
  const saved = await nextOf(page, "dock.save", () => ui(page, '.dock button[aria-label="Collapse"]').click());
  assert.equal(saved.prefs.collapsed, true);
  await ui(page, ".dock.collapsed").waitFor();
  await page.close();
});

test("area: drag draws a dashed box, captures the enclosing element, Escape cancels", async () => {
  const page = await openPage(prodUrl, { mode: true });
  await ui(page, ".dock").waitFor();
  const section = await page.locator("#pricing").boundingBox();
  const start = { x: section.x + 4, y: section.y + 4 };

  // Escape mid-drag cancels without a popover.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 100, start.y + 30, { steps: 4 });
  await ui(page, ".outline.area").waitFor();
  await page.keyboard.press("Escape");
  await ui(page, ".outline.area").waitFor({ state: "detached" });
  await page.mouse.up();
  assert.equal(await ui(page, ".popover").count(), 0);
  assert.equal(await page.evaluate(() => window.__sent.some((m) => m.t === "exit")), false, "Escape only cancelled the drag");

  // Drag across both cards (and over the Upgrade button): one area annotation, no page click.
  const upgrade = await page.locator("#upgrade").boundingBox();
  const end = { x: upgrade.x + upgrade.width - 2, y: upgrade.y + upgrade.height - 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  assert.match(await ui(page, ".hover-label").innerText(), /^area · \d+×\d+$/);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.pageClicks), 0, "drag end isn't a click");

  await ui(page, ".popover textarea").waitFor();
  await page.keyboard.type("Tighten the spacing between the cards");
  const add = await nextOf(page, "draft.add", () => page.keyboard.press("Control+Enter"));
  assert.equal(add.annotation.kind, "area");
  assert.equal(add.annotation.locator, "#pricing");
  assert.equal(add.annotation.text, "");
  assert.ok(Math.abs(add.annotation.rect.x - start.x) <= 1 && Math.abs(add.annotation.rect.y - start.y) <= 1);
  assert.ok(Math.abs(add.annotation.rect.width - (end.x - start.x)) <= 1);
  assert.ok(Math.abs(add.annotation.rect.height - (end.y - start.y)) <= 1);

  // The pin sits at the area's top-right, not the container's.
  const pin = await ui(page, 'button.pin[data-number="1"]').boundingBox();
  assert.ok(Math.abs(pin.x + pin.width / 2 - end.x) < 2, "pin at area's right edge");

  // A plain click still picks an element afterwards.
  await page.click("#upgrade");
  await ui(page, ".popover textarea").waitFor();
  await page.close();
});
