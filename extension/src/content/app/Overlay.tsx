import type { Annotation } from "@wish/shared";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { annotationBox, type Box } from "./layout";

export function Outline(props: { box: Box | null; label: string | null; area?: boolean }) {
  if (!props.box) return null;
  const { left, top, width, height } = props.box;
  const labelAbove = top > 28;
  return (
    <>
      <div class={`outline${props.area ? " area" : ""}`} style={{ left: `${left - 2}px`, top: `${top - 2}px`, width: `${width + 4}px`, height: `${height + 4}px` }} />
      {props.label && (
        <div
          class="hover-label"
          style={{ left: `${Math.max(4, left - 2)}px`, top: labelAbove ? `${top - 26}px` : `${top + height + 6}px` }}
        >
          {props.label}
        </div>
      )}
    </>
  );
}

/** Numbered pins at each annotation's top-right corner. Hover: tooltip. Click: edit. */
export function Pins(props: {
  annotations: Annotation[];
  /** Re-render trigger (scroll/resize/DOM changes). */
  tick: number;
  draftNumber: number | null;
  draftBox: Box | null;
  onOpen(id: string): void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <>
      {props.annotations.map((a, i) => {
        const { box, found } = annotationBox(a);
        const x = box.left + box.width;
        const y = box.top;
        return (
          <div key={a.id} class="pin-wrap" style={{ left: `${x}px`, top: `${y}px` }}>
            <button
              type="button"
              class={`pin${found ? "" : " detached"}`}
              data-number={i + 1}
              aria-label={`Comment ${i + 1}: ${a.comment}${found ? "" : " (element no longer found)"}`}
              onMouseEnter={() => setHover(a.id)}
              onMouseLeave={() => setHover((h) => (h === a.id ? null : h))}
              onFocus={() => setHover(a.id)}
              onBlur={() => setHover((h) => (h === a.id ? null : h))}
              onClick={() => props.onOpen(a.id)}
            >
              {i + 1}
            </button>
            {hover === a.id && (
              <div class="tooltip" role="tooltip">
                {!found && <div class="tooltip-warn">Element no longer found</div>}
                {a.comment}
              </div>
            )}
          </div>
        );
      })}
      {props.draftNumber !== null && props.draftBox && (
        <div class="pin-wrap" style={{ left: `${props.draftBox.left + props.draftBox.width}px`, top: `${props.draftBox.top}px` }}>
          <span class="pin draft" aria-hidden="true">
            {props.draftNumber}
          </span>
        </div>
      )}
    </>
  );
}

const POP_W = 300;
const POP_H = 170;

export function popoverPosition(box: Box): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, box.left), vw - POP_W - 8);
  const below = box.top + box.height + 10;
  const top = below + POP_H < vh ? below : Math.max(8, box.top - POP_H - 10);
  return { left, top: Math.min(Math.max(8, top), Math.max(8, vh - POP_H - 8)) };
}

/** Comment editor anchored to an element (new comment or editing a pin). */
export function CommentPopover(props: {
  box: Box;
  number: number;
  initial: string;
  editing: boolean;
  onSave(comment: string): void;
  onDelete?(): void;
  onCancel(): void;
}) {
  const [text, setText] = useState(props.initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(text.length, text.length);
    // Focus once on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pos = popoverPosition(props.box);
  const save = () => {
    if (text.trim()) props.onSave(text.trim());
  };
  return (
    <div
      class="popover"
      role="dialog"
      aria-label={props.editing ? `Edit comment ${props.number}` : `Comment ${props.number}`}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          props.onCancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          save();
        }
      }}
    >
      <textarea
        ref={ref}
        value={text}
        placeholder="What should change?"
        aria-label="What should change?"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <div class="row">
        <span class="hint">⌘/Ctrl+Enter to save</span>
        {props.onDelete && (
          <button type="button" class="danger-link" onClick={props.onDelete}>
            Delete
          </button>
        )}
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" class="primary" disabled={!text.trim()} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
