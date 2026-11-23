import type { Annotation, Point, Rect } from "@web-issuer/shared";

/** Data the picker captures; the panel adds the id. */
export type CapturedAnnotation = Omit<Annotation, "id">;

export interface PinSpec {
  number: number;
  locator: string;
  rect: Rect;
  scroll: Point;
}

/** Content script → panel. */
export type ContentMessage =
  | { type: "wi:annotation"; pageUrl: string; annotation: CapturedAnnotation }
  | { type: "wi:picker-state"; pageUrl: string; active: boolean };

/** Panel → content script. */
export type PanelMessage =
  | { type: "wi:start" }
  | { type: "wi:stop" }
  | { type: "wi:pins"; pins: PinSpec[] }
  | { type: "wi:highlight"; pin: PinSpec }
  | { type: "wi:ping" };
