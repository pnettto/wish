const MAX_DEPTH = 8;
const TEXT_LIMIT = 80;

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function attrValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isUnique(doc: ParentNode, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** Ids that look generated (long digit runs, hashes) make poor references. */
function stableId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && !/\d{4,}/.test(id) && !/^[0-9]/.test(id) && !/[:.]r\d|^:r/.test(id);
}

/** A selector that identifies the element by itself, if one exists. */
function anchorSelector(el: Element, root: ParentNode): string | null {
  if (el.id && stableId(el.id)) {
    const sel = `#${cssEscape(el.id)}`;
    if (isUnique(root, sel, el)) return sel;
  }
  const testId = el.getAttribute("data-testid");
  if (testId) {
    const sel = `[data-testid=${attrValue(testId)}]`;
    if (isUnique(root, sel, el)) return sel;
  }
  const label = el.getAttribute("aria-label");
  if (label && label.length <= 80) {
    const sel = `${el.localName}[aria-label=${attrValue(label)}]`;
    if (isUnique(root, sel, el)) return sel;
  }
  return null;
}

function segment(el: Element): string {
  const tag = el.localName;
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag = [...parent.children].filter((c) => c.localName === tag);
  if (sameTag.length === 1) return tag;
  return `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
}

/**
 * Best-effort CSS locator: prefer #id, [data-testid], [aria-label], else a
 * short child path with :nth-of-type, anchored at the nearest identifiable
 * ancestor. A hint for humans and agents, not a permanent identifier.
 */
export function buildLocator(el: Element): string {
  const doc = el.ownerDocument;
  const own = anchorSelector(el, doc);
  if (own) return own;

  // Walk up to the nearest identifiable ancestor (or <body>), recording
  // :nth-of-type segments on the way.
  const segments: string[] = [];
  let anchor: string | null = null;
  let current: Element | null = el;
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    if (current === doc.body || current === doc.documentElement) {
      anchor = current.localName;
      break;
    }
    if (depth > 0) {
      anchor = anchorSelector(current, doc);
      if (anchor) break;
    }
    segments.unshift(segment(current));
    current = current.parentElement;
  }

  if (anchor) {
    const anchored = [anchor, ...segments].join(" > ");
    if (isUnique(doc, anchored, el)) return anchored;
  }
  // No anchor in reach: use the shortest unique suffix of the path.
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments.slice(i).join(" > ");
    if (isUnique(doc, candidate, el)) return candidate;
  }
  return segments.join(" > ");
}

const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  img: "img",
  input: "textbox",
  select: "combobox",
  textarea: "textbox",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  nav: "navigation",
  ul: "list",
  ol: "list",
  li: "listitem",
  table: "table",
  form: "form",
  dialog: "dialog",
};

const INPUT_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  button: "button",
  submit: "button",
  reset: "button",
  range: "slider",
  search: "searchbox",
};

export function roleOf(el: Element): string | null {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = el.localName;
  if (tag === "a" && !el.hasAttribute("href")) return null;
  if (tag === "input") return INPUT_ROLES[(el.getAttribute("type") ?? "text").toLowerCase()] ?? "textbox";
  return IMPLICIT_ROLES[tag] ?? null;
}

/** Short label for the issue's "Target:" line. */
export function kindOf(el: Element): string {
  const role = roleOf(el);
  if (role) {
    if (role === "img") return "image";
    if (role === "textbox" || role === "searchbox") return "input";
    return role;
  }
  if (["p", "span", "label", "strong", "em", "small", "b", "i", "td", "th", "dd", "dt", "blockquote"].includes(el.localName)) {
    return "text";
  }
  return el.localName;
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > TEXT_LIMIT ? `${clean.slice(0, TEXT_LIMIT - 1).trimEnd()}…` : clean;
}

const FORM_FIELDS = new Set(["input", "textarea", "select"]);

/**
 * Visible-text excerpt (≤ 80 chars). Form fields never contribute their
 * value: only their label, aria-label, placeholder or name.
 */
export function textExcerpt(el: Element): string {
  if (FORM_FIELDS.has(el.localName)) {
    const aria = el.getAttribute("aria-label");
    if (aria) return truncate(aria);
    const id = el.getAttribute("id");
    if (id) {
      const label = el.ownerDocument.querySelector(`label[for=${attrValue(id)}]`);
      if (label?.textContent) return truncate(label.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const clone = wrapping.cloneNode(true) as Element;
      clone.querySelectorAll("input, textarea, select").forEach((n) => n.remove());
      if (clone.textContent?.trim()) return truncate(clone.textContent);
    }
    return truncate(el.getAttribute("placeholder") ?? el.getAttribute("name") ?? "");
  }
  if (el.localName === "img") return truncate(el.getAttribute("alt") ?? "");
  const aria = el.getAttribute("aria-label");
  // Clone to drop the values of any nested form fields and hidden scripts.
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll("input, textarea, select, script, style, noscript").forEach((n) => n.remove());
  const html = el as HTMLElement;
  let text = clone.textContent ?? "";
  if (typeof html.innerText === "string" && !el.querySelector("input, textarea, select")) {
    text = html.innerText || text;
  }
  return truncate(text || aria || el.getAttribute("title") || "");
}
