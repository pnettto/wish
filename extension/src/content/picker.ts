import type { CapturedAnnotation, PinSpec } from "../messages";
import { buildLocator, kindOf, roleOf, textExcerpt } from "./locator";

export const HOST_TAG = "web-issuer-overlay";

export interface PickerCallbacks {
  onAnnotation(annotation: CapturedAnnotation): void;
  onActiveChange(active: boolean): void;
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; }
.outline {
  position: fixed; pointer-events: none; display: none; z-index: 2147483646;
  border: 1.5px solid var(--accent); border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.outline.flash { transition: opacity .6s ease; }
.pin {
  position: absolute; min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px; background: var(--accent); color: #fff;
  font: 600 11px/20px system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center;
  box-shadow: 0 1px 3px rgba(0,0,0,.25); transform: translate(-50%, -50%); pointer-events: none;
}
.pin.draft { background: var(--ink); }
.popover {
  position: absolute; width: 280px; padding: 10px; border-radius: 8px;
  background: var(--bg); color: var(--ink); border: 1px solid var(--line);
  box-shadow: 0 6px 24px rgba(0,0,0,.18);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.popover textarea {
  width: 100%; min-height: 64px; resize: vertical; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--field); color: var(--ink); font: inherit;
}
.popover textarea:focus-visible, .popover button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
button {
  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line); background: transparent; color: var(--ink);
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
.hint { color: var(--muted); font-size: 11px; margin-right: auto; align-self: center; }
.layer {
  --accent: #5b6b8c; --bg: #fbfaf7; --ink: #23221f; --muted: #77736b; --line: #dedad2; --field: #fff;
}
@media (prefers-color-scheme: dark) {
  .layer { --accent: #8d9cc0; --bg: #24231f; --ink: #ecebe6; --muted: #a29e95; --line: #3b3934; --field: #1c1b18; }
}
@media (prefers-reduced-motion: reduce) { .outline.flash { transition: none; } }
`;

function docPoint(rect: { x: number; y: number; width: number }, scroll: { x: number; y: number }) {
  return { left: rect.x + scroll.x + rect.width, top: rect.y + scroll.y };
}

/**
 * Page overlay: hover outline, numbered pins, and the comment popover. All UI
 * lives in a shadow root so page CSS can't affect it. Outside selection mode
 * it only shows pins (which ignore pointer events).
 */
export class Picker {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly layer: HTMLDivElement;
  private readonly outline: HTMLDivElement;
  private readonly pinLayer: HTMLDivElement;
  private popover: HTMLDivElement | null = null;
  private draftPin: HTMLDivElement | null = null;
  private active = false;
  private hovered: Element | null = null;
  private pinCount = 0;

  constructor(
    private readonly doc: Document,
    private readonly callbacks: PickerCallbacks,
  ) {
    this.host = doc.createElement(HOST_TAG);
    this.host.setAttribute("data-web-issuer", "");
    this.root = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    this.layer = doc.createElement("div");
    this.layer.className = "layer";
    this.outline = doc.createElement("div");
    this.outline.className = "outline";
    this.pinLayer = doc.createElement("div");
    this.layer.append(this.outline, this.pinLayer);
    this.root.append(style, this.layer);
    this.host.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;";
    doc.documentElement.append(this.host);
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const win = this.doc.defaultView!;
    win.addEventListener("mousemove", this.onMove, true);
    win.addEventListener("click", this.onClick, true);
    win.addEventListener("mousedown", this.swallow, true);
    win.addEventListener("mouseup", this.swallow, true);
    win.addEventListener("pointerdown", this.swallow, true);
    win.addEventListener("pointerup", this.swallow, true);
    win.addEventListener("keydown", this.onKey, true);
    win.addEventListener("scroll", this.onScroll, true);
    this.doc.documentElement.style.setProperty("cursor", "crosshair", "important");
    this.callbacks.onActiveChange(true);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.closePopover();
    const win = this.doc.defaultView!;
    win.removeEventListener("mousemove", this.onMove, true);
    win.removeEventListener("click", this.onClick, true);
    win.removeEventListener("mousedown", this.swallow, true);
    win.removeEventListener("mouseup", this.swallow, true);
    win.removeEventListener("pointerdown", this.swallow, true);
    win.removeEventListener("pointerup", this.swallow, true);
    win.removeEventListener("keydown", this.onKey, true);
    win.removeEventListener("scroll", this.onScroll, true);
    this.doc.documentElement.style.removeProperty("cursor");
    this.hideOutline();
    this.callbacks.onActiveChange(false);
  }

  /** Replace pins with the panel's list (the panel owns numbering). */
  setPins(pins: PinSpec[]): void {
    this.pinLayer.replaceChildren();
    this.pinCount = pins.length;
    for (const pin of pins) {
      const el = this.doc.createElement("div");
      el.className = "pin";
      el.textContent = String(pin.number);
      el.dataset.number = String(pin.number);
      const pos = this.pinPosition(pin);
      el.style.left = `${pos.left}px`;
      el.style.top = `${pos.top}px`;
      this.pinLayer.append(el);
    }
  }

  /** Scroll to and briefly outline an annotation's target. */
  highlight(pin: PinSpec): boolean {
    const el = this.find(pin.locator);
    const win = this.doc.defaultView!;
    if (el) {
      el.scrollIntoView({ block: "center", behavior: win.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } else {
      win.scrollTo({ left: pin.scroll.x, top: Math.max(0, pin.scroll.y + pin.rect.y - win.innerHeight / 3) });
    }
    const show = () => {
      const rect = el ? el.getBoundingClientRect() : this.fallbackRect(pin);
      this.showOutline(rect);
      this.outline.classList.add("flash");
      win.setTimeout(() => {
        if (!this.active) this.hideOutline();
        this.outline.classList.remove("flash");
      }, 1600);
    };
    win.setTimeout(show, 350);
    return !!el;
  }

  destroy(): void {
    this.stop();
    this.host.remove();
  }

  // -------------------------------------------------------------------------

  private find(locator: string): Element | null {
    try {
      return locator ? this.doc.querySelector(locator) : null;
    } catch {
      return null;
    }
  }

  private fallbackRect(pin: PinSpec): DOMRect {
    const win = this.doc.defaultView!;
    return new DOMRect(
      pin.rect.x + pin.scroll.x - win.scrollX,
      pin.rect.y + pin.scroll.y - win.scrollY,
      pin.rect.width,
      pin.rect.height,
    );
  }

  private pinPosition(pin: PinSpec): { left: number; top: number } {
    const el = this.find(pin.locator);
    const win = this.doc.defaultView!;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width || r.height) return docPoint(r, { x: win.scrollX, y: win.scrollY });
    }
    return docPoint(pin.rect, pin.scroll);
  }

  private isOwn(target: EventTarget | null): boolean {
    return target instanceof Node && (target === this.host || this.host.contains(target));
  }

  private targetAt(event: MouseEvent): Element | null {
    const path = event.composedPath();
    if (path.includes(this.host)) return null;
    const el = path.find((n): n is Element => n instanceof Element) ?? null;
    if (!el || el === this.doc.documentElement || el === this.doc.body) return null;
    return el;
  }

  private readonly swallow = (event: Event) => {
    if (this.isOwn(event.target) || event.composedPath().includes(this.host)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onMove = (event: MouseEvent) => {
    if (this.popover) return;
    const el = this.targetAt(event);
    this.hovered = el;
    if (el) this.showOutline(el.getBoundingClientRect());
    else this.hideOutline();
  };

  private readonly onScroll = () => {
    if (this.hovered && !this.popover) this.showOutline(this.hovered.getBoundingClientRect());
  };

  private readonly onClick = (event: MouseEvent) => {
    if (event.composedPath().includes(this.host)) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.popover) {
      // Clicking elsewhere while a comment is open keeps focus on the comment.
      this.popover.querySelector("textarea")?.focus();
      return;
    }
    const el = this.targetAt(event);
    if (el) this.openPopover(el);
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (this.popover) this.closePopover();
    else this.stop();
  };

  private showOutline(rect: DOMRect | DOMRectReadOnly): void {
    Object.assign(this.outline.style, {
      display: "block",
      left: `${rect.left - 2}px`,
      top: `${rect.top - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
    });
  }

  private hideOutline(): void {
    this.outline.style.display = "none";
  }

  private capture(el: Element): Omit<CapturedAnnotation, "comment"> {
    const win = this.doc.defaultView!;
    const r = el.getBoundingClientRect();
    const text = textExcerpt(el);
    return {
      locator: buildLocator(el),
      tag: el.localName,
      role: roleOf(el),
      kind: kindOf(el),
      text,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
    };
  }

  private openPopover(el: Element): void {
    const data = this.capture(el);
    this.showOutline(el.getBoundingClientRect());
    const win = this.doc.defaultView!;
    const pos = docPoint(data.rect, data.scroll);

    const pin = this.doc.createElement("div");
    pin.className = "pin draft";
    pin.textContent = String(this.pinCount + 1);
    pin.style.left = `${pos.left}px`;
    pin.style.top = `${pos.top}px`;
    this.pinLayer.append(pin);
    this.draftPin = pin;

    const pop = this.doc.createElement("div");
    pop.className = "popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Comment");
    const width = 280;
    const left = Math.min(Math.max(8 + win.scrollX, data.rect.x + data.scroll.x), win.scrollX + win.innerWidth - width - 8);
    const below = data.rect.y + data.rect.height + 8;
    const top = below + 150 < win.innerHeight ? below : Math.max(8, data.rect.y - 150);
    pop.style.left = `${left}px`;
    pop.style.top = `${top + data.scroll.y}px`;

    const textarea = this.doc.createElement("textarea");
    textarea.placeholder = "What should change?";
    textarea.setAttribute("aria-label", "What should change?");
    const hint = this.doc.createElement("span");
    hint.className = "hint";
    hint.textContent = "⌘/Ctrl+Enter to save";
    const cancel = this.doc.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const save = this.doc.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Save";
    save.disabled = true;
    const row = this.doc.createElement("div");
    row.className = "row";
    row.append(hint, cancel, save);
    pop.append(textarea, row);
    this.layer.append(pop);
    this.popover = pop;

    // Keep the page from reacting to typing while the popover is open.
    pop.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.closePopover();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    pop.addEventListener("keyup", (e) => e.stopPropagation());
    pop.addEventListener("keypress", (e) => e.stopPropagation());
    textarea.addEventListener("input", () => {
      save.disabled = textarea.value.trim() === "";
    });
    cancel.addEventListener("click", () => this.closePopover());
    const submit = () => {
      const comment = textarea.value.trim();
      if (!comment) return;
      this.pinCount += 1;
      this.draftPin?.classList.remove("draft");
      this.draftPin = null;
      this.closePopover();
      this.callbacks.onAnnotation({ ...data, comment });
    };
    save.addEventListener("click", submit);
    textarea.focus();
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
    this.draftPin?.remove();
    this.draftPin = null;
    if (!this.active) this.hideOutline();
  }
}
