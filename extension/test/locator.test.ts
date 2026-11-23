import { beforeEach, describe, expect, it } from "vitest";
import { buildLocator, kindOf, roleOf, textExcerpt } from "../src/content/locator";

function page(html: string) {
  document.body.innerHTML = html;
}
const $ = (sel: string) => document.querySelector(sel)!;
const resolves = (el: Element) => {
  const loc = buildLocator(el);
  const found = document.querySelectorAll(loc);
  expect(found.length, loc).toBe(1);
  expect(found[0], loc).toBe(el);
  return loc;
};

beforeEach(() => page(""));

describe("buildLocator", () => {
  it("prefers a unique id", () => {
    page(`<button id="buy">Buy</button>`);
    expect(resolves($("button"))).toBe("#buy");
  });

  it("escapes ids", () => {
    page(`<div id="a.b:c">x</div>`);
    expect(resolves($("div"))).toBe("#a\\.b\\:c");
  });

  it("skips generated-looking ids", () => {
    page(`<main><div id="ember12345">x</div><div>y</div></main>`);
    expect(resolves($("div"))).not.toContain("ember");
  });

  it("uses data-testid, then aria-label", () => {
    page(`<span data-testid="usage-limit">10,000 requests</span><button aria-label="Close dialog">×</button><button aria-label="Close dialog">×</button>`);
    expect(resolves($("span"))).toBe('[data-testid="usage-limit"]');
    const second = document.querySelectorAll("button")[1]!;
    expect(resolves(second)).toBe("body > button:nth-of-type(2)");
  });

  it("builds a short nth-of-type path anchored at an identifiable ancestor", () => {
    page(`<section id="pricing"><div class="card"><button>Free</button></div><div class="card"><p>x</p><button>Upgrade</button></div></section>`);
    const upgrade = document.querySelectorAll("button")[1]!;
    expect(resolves(upgrade)).toBe("#pricing > div:nth-of-type(2) > button");
  });

  it("always resolves to the element in nested anonymous markup", () => {
    page(`<div><ul><li><a href="#">a</a></li><li><a href="#">b</a></li></ul></div><div><ul><li><a href="#">c</a></li></ul></div>`);
    for (const a of document.querySelectorAll("a")) resolves(a);
  });
});

describe("roles and kinds", () => {
  it("maps implicit roles", () => {
    page(`<a href="/x">x</a><a>y</a><input type="checkbox"><input><h2>T</h2><p>para</p><div role="tab button">t</div><img alt="Logo">`);
    expect(roleOf($("a[href]"))).toBe("link");
    expect(roleOf(document.querySelectorAll("a")[1]!)).toBeNull();
    expect(roleOf($("input[type=checkbox]"))).toBe("checkbox");
    expect(kindOf(document.querySelectorAll("input")[1]!)).toBe("input");
    expect(kindOf($("h2"))).toBe("heading");
    expect(kindOf($("p"))).toBe("text");
    expect(roleOf($("[role]"))).toBe("tab");
    expect(kindOf($("img"))).toBe("image");
  });
});

describe("textExcerpt", () => {
  it("collapses whitespace and truncates to 80 chars", () => {
    page(`<p>  Hello\n   world  </p><p>${"x".repeat(200)}</p>`);
    expect(textExcerpt($("p"))).toBe("Hello world");
    const long = textExcerpt(document.querySelectorAll("p")[1]!);
    expect(long.length).toBe(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("never captures input values", () => {
    page(`
      <label for="email">Email address</label><input id="email" value="me@secret.example">
      <input aria-label="Search" value="private query">
      <label>Card <input name="cc" value="4242424242424242"></label>
      <textarea placeholder="Your message">top secret</textarea>
      <div id="wrap">Total: <input value="hunter2"> due</div>`);
    const inputs = document.querySelectorAll("input");
    (inputs[0] as HTMLInputElement).value = "typed@secret.example";
    expect(textExcerpt(inputs[0]!)).toBe("Email address");
    expect(textExcerpt(inputs[1]!)).toBe("Search");
    expect(textExcerpt(inputs[2]!)).toBe("Card");
    expect(textExcerpt($("textarea"))).toBe("Your message");
    const wrap = textExcerpt($("#wrap"));
    expect(wrap).toBe("Total: due");
    for (const out of [wrap, ...[...inputs].map(textExcerpt)]) {
      expect(out).not.toMatch(/secret|4242|hunter2|private/);
    }
  });

  it("uses alt text for images", () => {
    page(`<img alt="Company logo">`);
    expect(textExcerpt($("img"))).toBe("Company logo");
  });
});
