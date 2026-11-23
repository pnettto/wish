// Playwright smoke test for the content-script picker (PLAN §0.4 Phase C).
// Loads a local fixture page, injects the built dist/content.js with a stubbed
// `chrome.runtime`, and checks hover outline, pin placement, Escape and the
// captured annotation data.
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

let server;
let browser;
let baseUrl;

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fixture);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}/pricing?session=abc`;
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox"],
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    window.__sent = [];
    window.chrome = {
      runtime: {
        sendMessage: (m) => {
          window.__sent.push(m);
          return Promise.resolve();
        },
        onMessage: { addListener: (fn) => (window.__listener = fn) },
      },
    };
    // Simulates chrome.tabs.sendMessage from the panel.
    window.__panel = (message) =>
      new Promise((resolve) => {
        const handled = window.__listener(message, {}, resolve);
        if (!handled) setTimeout(() => resolve(undefined), 0);
      });
  });
  await page.goto(baseUrl);
  await page.addScriptTag({ path: contentScript });
  return page;
}

const shadow = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector("web-issuer-overlay")?.shadowRoot?.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { display: getComputedStyle(el).display, text: el.textContent, x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);

test("hover outline, pin, comment capture, Escape", async () => {
  const page = await openPage();
  assert.deepEqual(await page.evaluate(() => window.__panel({ type: "wi:ping" })), { ok: true, active: false });

  // Nothing on the page reacts before selection mode.
  await page.click("#upgrade");
  assert.equal(await page.evaluate(() => window.pageClicks), 1);

  await page.evaluate(() => window.__panel({ type: "wi:start" }));
  assert.deepEqual(await page.evaluate(() => window.__sent.at(-1)), {
    type: "wi:picker-state",
    pageUrl: baseUrl,
    active: true,
  });

  // Hover → outline around the target.
  await page.hover("#upgrade");
  const button = await page.locator("#upgrade").boundingBox();
  const outline = await shadow(page, ".outline");
  assert.equal(outline.display, "block");
  assert.ok(Math.abs(outline.x - (button.x - 2)) < 1.5, "outline aligned horizontally");
  assert.ok(Math.abs(outline.width - (button.width + 4)) < 1.5, "outline width");

  // Click → draft pin + popover, page handler not triggered.
  await page.click("#upgrade");
  assert.equal(await page.evaluate(() => window.pageClicks), 1, "page click swallowed in selection mode");
  assert.ok(await shadow(page, ".popover"), "popover open");
  assert.equal((await shadow(page, ".pin.draft")).text, "1");

  // Type and save via keyboard focus in the shadow root.
  await page.keyboard.type("Make the upgrade button less prominent");
  await page.evaluate(() => document.querySelector("web-issuer-overlay").shadowRoot.querySelector("button.primary").click());
  assert.equal(await shadow(page, ".popover"), null, "popover closed after save");

  const annotation = await page.evaluate(() => window.__sent.find((m) => m.type === "wi:annotation"));
  assert.equal(annotation.pageUrl, baseUrl);
  const a = annotation.annotation;
  assert.equal(a.comment, "Make the upgrade button less prominent");
  assert.equal(a.locator, "#upgrade");
  assert.equal(a.tag, "button");
  assert.equal(a.kind, "button");
  assert.equal(a.text, "Upgrade");
  assert.deepEqual(a.viewport, { width: 1280, height: 800 });
  assert.equal(a.rect.width, Math.round(button.width));

  // Pin stays after save (until the panel sends its list).
  const pin = await shadow(page, ".pin");
  assert.equal(pin.text, "1");
  assert.ok(Math.abs(pin.x + pin.width / 2 - (button.x + button.width)) < 2, "pin at the target's top-right");

  // Second annotation: a form field never leaks its value.
  await page.click("#email");
  await page.keyboard.type("Clarify this label");
  await page.keyboard.press("Control+Enter");
  const second = await page.evaluate(() => window.__sent.filter((m) => m.type === "wi:annotation")[1].annotation);
  assert.equal(second.locator, "#email");
  assert.equal(second.text, "Email");
  assert.ok(!JSON.stringify(second).includes("secret"), "input value not captured");

  // Escape with a popover open cancels the comment only.
  await page.click('[data-testid="usage-limit"]');
  await page.keyboard.press("Escape");
  assert.equal(await shadow(page, ".popover"), null);
  assert.equal(await page.evaluate(() => window.__panel({ type: "wi:ping" }).then((r) => r.active)), true);
  assert.equal(await page.evaluate(() => window.__sent.filter((m) => m.type === "wi:annotation").length), 2);

  // Escape again leaves selection mode; the page behaves normally.
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.evaluate(() => window.__sent.at(-1)), { type: "wi:picker-state", pageUrl: baseUrl, active: false });
  assert.equal((await shadow(page, ".outline")).display, "none");
  await page.click("#upgrade");
  assert.equal(await page.evaluate(() => window.pageClicks), 2);

  // Panel-driven pins and highlight.
  await page.evaluate(() =>
    window.__panel({
      type: "wi:pins",
      pins: [{ number: 1, locator: '[data-testid="usage-limit"]', rect: { x: 0, y: 0, width: 10, height: 10 }, scroll: { x: 0, y: 0 } }],
    }),
  );
  assert.equal(await page.evaluate(() => document.querySelector("web-issuer-overlay").shadowRoot.querySelectorAll(".pin").length), 1);
  const res = await page.evaluate(() =>
    window.__panel({ type: "wi:highlight", pin: { number: 1, locator: "#missing", rect: { x: 0, y: 0, width: 1, height: 1 }, scroll: { x: 0, y: 0 } } }),
  );
  assert.deepEqual(res, { ok: true, found: false });

  // Re-injection reuses the instance.
  await page.addScriptTag({ path: contentScript });
  assert.equal(await page.evaluate(() => document.querySelectorAll("web-issuer-overlay").length), 1);
  await page.close();
});
