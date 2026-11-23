import type { Annotation } from "@web-issuer/shared";
import { useEffect, useState } from "preact/hooks";

/**
 * Re-render on scroll, resize and DOM changes (rAF-throttled) so pins and
 * outlines follow their elements.
 */
export function useLayoutTick(enabled: boolean, observe: Element[] = []): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((t) => t + 1);
      });
    };
    window.addEventListener("scroll", bump, { capture: true, passive: true });
    window.addEventListener("resize", bump, { passive: true });
    const mo = new MutationObserver(bump);
    mo.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(bump) : null;
    for (const el of observe) ro?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", bump, { capture: true });
      window.removeEventListener("resize", bump);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [enabled, observe.length, ...observe]);
  return tick;
}

export function findTarget(locator: string): Element | null {
  if (!locator) return null;
  try {
    return document.querySelector(locator);
  } catch {
    return null;
  }
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Current viewport box of an annotation's element, or its captured box if the element is gone. */
export function annotationBox(a: Annotation): { box: Box; found: boolean } {
  const el = findTarget(a.locator);
  if (a.kind === "area") {
    // Areas keep their dragged rect (in document coordinates); the locator only says whether the content is still there.
    return {
      box: { left: a.rect.x + a.scroll.x - window.scrollX, top: a.rect.y + a.scroll.y - window.scrollY, width: a.rect.width, height: a.rect.height },
      found: !!el,
    };
  }
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width || r.height) return { box: { left: r.left, top: r.top, width: r.width, height: r.height }, found: true };
  }
  return {
    box: {
      left: a.rect.x + a.scroll.x - window.scrollX,
      top: a.rect.y + a.scroll.y - window.scrollY,
      width: a.rect.width,
      height: a.rect.height,
    },
    found: false,
  };
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
