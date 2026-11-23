import type { CapturedAnnotation } from "../messages";
import { buildLocator, kindOf, roleOf, textExcerpt } from "./locator";

export interface PickerEvents {
  /** Hovered (or keyboard-selected) element changed. */
  onHover(el: Element | null): void;
  /** The user picked an element to comment on. */
  onPick(el: Element): void;
  /** Escape pressed on the page (not inside Wish's UI). */
  onEscape(): void;
  /** ⌘/Ctrl+Enter on the page. */
  onSendShortcut(): void;
  /** "?" on the page. */
  onHelp(): void;
  /** The page was clicked while a comment popover is open. */
  onBusyClick(): void;
  /** Area drag in progress (viewport box), or null when it ends/cancels. */
  onAreaDrag(box: AreaBox | null): void;
  /** The user dragged out an area; `container` is the nearest element enclosing it. */
  onAreaPick(box: AreaBox, container: Element): void;
}

export interface AreaBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Minimum pointer travel (px) before a press becomes an area drag instead of a click. */
export const DRAG_THRESHOLD = 6;

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** Snapshot of an element for an annotation (without the comment). */
export function captureElement(el: Element, win: Window): Omit<CapturedAnnotation, "comment"> {
  const r = el.getBoundingClientRect();
  return {
    locator: buildLocator(el),
    tag: el.localName,
    role: roleOf(el),
    kind: kindOf(el),
    text: textExcerpt(el),
    rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    viewport: { width: win.innerWidth, height: win.innerHeight },
    scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
  };
}

/** Snapshot for an area annotation: locator of the enclosing element, rect of the dragged area. */
export function captureArea(box: AreaBox, container: Element, win: Window): Omit<CapturedAnnotation, "comment"> {
  return {
    locator: buildLocator(container),
    tag: container.localName,
    role: null,
    kind: "area",
    text: "",
    rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
    viewport: { width: win.innerWidth, height: win.innerHeight },
    scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
  };
}

/** Nearest element enclosing the whole area (sampled at its corners and centre), ignoring `host`. */
export function areaContainer(doc: Document, box: AreaBox, host: Element): Element {
  const inset = (v: number, size: number) => Math.min(v + 1, v + size / 2);
  const xs = [inset(box.left, box.width), box.left + box.width / 2, Math.max(box.left + box.width - 1, box.left + box.width / 2)];
  const ys = [inset(box.top, box.height), box.top + box.height / 2, Math.max(box.top + box.height - 1, box.top + box.height / 2)];
  let common: Element | null = null;
  for (const x of xs) {
    for (const y of ys) {
      const el = doc.elementsFromPoint(x, y).find((e) => e !== host && !host.contains(e));
      if (!el) continue;
      common = common ? commonAncestor(common, el) : el;
    }
  }
  return common ?? doc.body ?? doc.documentElement;
}

function commonAncestor(a: Element, b: Element): Element {
  for (let n: Element | null = a; n; n = n.parentElement) if (n.contains(b)) return n;
  return b.ownerDocument.documentElement;
}

/** Hover label, e.g. `button "Save" · 120×32`. */
export function elementLabel(el: Element): string {
  const r = el.getBoundingClientRect();
  const text = textExcerpt(el);
  const short = text.length > 32 ? `${text.slice(0, 31)}…` : text;
  return `${kindOf(el)}${short ? ` "${short}"` : ""} · ${Math.round(r.width)}×${Math.round(r.height)}`;
}

const SWALLOWED = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu", "auxclick"] as const;

/**
 * Selection engine for feedback mode: tracks the hovered element, swallows
 * page clicks (Alt-click passes through), supports keyboard selection
 * (Tab focus, ↑/↓ parent/child, Enter to pick). Draws nothing itself.
 */
export class Picker {
  private active = false;
  /** A comment popover is open: freeze the hover target. */
  busy = false;
  private current: Element | null = null;
  /** Press position while the primary button is down (a drag candidate). */
  private press: { x: number; y: number } | null = null;
  private dragging = false;
  /** Swallow the click that ends a drag. */
  private suppressClick = false;
  /** A drag was cancelled with Escape; the release that follows isn't a click either. */
  private cancelledPress = false;

  constructor(
    private readonly doc: Document,
    private readonly host: Element,
    private readonly events: PickerEvents,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get hovered(): Element | null {
    return this.current;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const win = this.doc.defaultView!;
    win.addEventListener("mousemove", this.onMove, true);
    // Pointer events: the swallowed pointerdown suppresses the compatibility mouse events during a press.
    win.addEventListener("pointerdown", this.onDown, true);
    win.addEventListener("pointermove", this.onDrag, true);
    win.addEventListener("pointerup", this.onUp, true);
    win.addEventListener("click", this.onClick, true);
    for (const t of SWALLOWED) win.addEventListener(t, this.swallow, true);
    win.addEventListener("keydown", this.onKey, true);
    win.addEventListener("focusin", this.onFocus, true);
    this.doc.documentElement.style.setProperty("cursor", "crosshair", "important");
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const win = this.doc.defaultView!;
    win.removeEventListener("mousemove", this.onMove, true);
    win.removeEventListener("pointerdown", this.onDown, true);
    win.removeEventListener("pointermove", this.onDrag, true);
    win.removeEventListener("pointerup", this.onUp, true);
    win.removeEventListener("click", this.onClick, true);
    for (const t of SWALLOWED) win.removeEventListener(t, this.swallow, true);
    win.removeEventListener("keydown", this.onKey, true);
    win.removeEventListener("focusin", this.onFocus, true);
    this.doc.documentElement.style.removeProperty("cursor");
    this.cancelDrag();
    this.set(null);
  }

  private cancelDrag(): void {
    const was = this.dragging;
    this.press = null;
    this.dragging = false;
    if (was) this.events.onAreaDrag(null);
  }

  private boxTo(event: MouseEvent): AreaBox {
    const p = this.press!;
    return {
      left: Math.min(p.x, event.clientX),
      top: Math.min(p.y, event.clientY),
      width: Math.abs(event.clientX - p.x),
      height: Math.abs(event.clientY - p.y),
    };
  }

  private readonly onDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.altKey || this.busy || this.own(event)) return;
    this.press = { x: event.clientX, y: event.clientY };
    this.cancelledPress = false;
    this.dragging = false;
  };

  private swallowNextClick(): void {
    this.suppressClick = true;
    // A release outside the window produces no click; don't swallow the next real one.
    setTimeout(() => (this.suppressClick = false), 0);
  }

  private readonly onUp = (event: MouseEvent) => {
    if (this.cancelledPress) {
      this.cancelledPress = false;
      this.swallowNextClick();
      return;
    }
    if (!this.press) return;
    if (this.dragging) {
      const box = this.boxTo(event);
      this.cancelDrag();
      this.swallowNextClick();
      this.events.onAreaPick(box, areaContainer(this.doc, box, this.host));
      return;
    }
    this.press = null;
  };

  /** Select an element programmatically (traversal). */
  set(el: Element | null): void {
    if (el === this.current) return;
    this.current = el;
    this.events.onHover(el);
  }

  private own(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  private pickable(el: Element | null): Element | null {
    if (!el || el === this.doc.documentElement || el === this.doc.body || el === this.host) return null;
    return el;
  }

  private targetOf(event: Event): Element | null {
    if (this.own(event)) return null;
    return this.pickable(event.composedPath().find((n): n is Element => n instanceof Element) ?? null);
  }

  private readonly swallow = (event: Event) => {
    if (this.own(event) || (event as MouseEvent).altKey) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onDrag = (event: PointerEvent) => {
    if (!this.press || this.busy) return;
    if (!(event.buttons & 1)) {
      this.cancelDrag(); // Button released somewhere we didn't see.
      return;
    }
    if (this.dragging || Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) >= DRAG_THRESHOLD) {
      if (!this.dragging) this.set(null);
      this.dragging = true;
      this.events.onAreaDrag(this.boxTo(event));
    }
  };

  private readonly onMove = (event: MouseEvent) => {
    if (this.dragging || this.busy || this.own(event)) return;
    this.set(this.targetOf(event));
  };

  private readonly onFocus = (event: FocusEvent) => {
    if (this.busy || this.own(event)) return;
    this.set(this.targetOf(event));
  };

  private readonly onClick = (event: MouseEvent) => {
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (this.own(event)) return;
    if (event.altKey) return; // Alt-click: let the page handle it (open menus, then annotate).
    event.preventDefault();
    event.stopPropagation();
    if (this.busy) {
      this.events.onBusyClick();
      return;
    }
    const el = this.targetOf(event);
    if (el) {
      this.set(el);
      this.events.onPick(el);
    }
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (this.own(event)) return;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      stop();
      if (this.dragging) {
        this.cancelDrag();
        this.cancelledPress = true;
        return;
      }
      this.events.onEscape();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      stop();
      this.events.onSendShortcut();
      return;
    }
    if (this.busy) return;
    if (event.key === "?" && !isEditable(event.target)) {
      stop();
      this.events.onHelp();
      return;
    }
    const el = this.current;
    if (!el) return;
    if (event.key === "ArrowUp" && !event.altKey && !isEditable(event.target)) {
      stop();
      const parent = this.pickable(el.parentElement);
      if (parent) this.set(parent);
    } else if (event.key === "ArrowDown" && !event.altKey && !isEditable(event.target)) {
      stop();
      const child = el.firstElementChild;
      if (child) this.set(child);
    } else if (event.key === "Enter" && !isEditable(event.target)) {
      stop();
      this.events.onPick(el);
    }
  };
}
