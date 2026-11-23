import type { RequestView } from "@web-issuer/shared";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Snapshot, ToBg } from "../../messages";
import { canFollowUp } from "../../page";
import { captureArea, captureElement, elementLabel, Picker, type AreaBox } from "../picker";
import { PreviewBanner, PreviewNotice, ShortcutSheet, usePreviewTitle } from "./Banner";
import { Dock } from "./Dock";
import { annotationBox, useLayoutTick, type Box } from "./layout";
import { CommentPopover, Outline, Pins } from "./Overlay";

type Pop =
  | { kind: "new"; el: Element }
  | { kind: "area"; box: AreaBox; container: Element; scroll: { x: number; y: number } }
  | { kind: "edit"; id: string };

export interface AppProps {
  snapshot: Snapshot | null;
  send(msg: ToBg): void;
  host: Element;
}

function rectBox(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Whether there's anything to show (otherwise render nothing at all). */
export function visible(s: Snapshot): boolean {
  return s.mode || !!s.sending || !!s.preview || !!s.request || (s.draft?.annotations.length ?? 0) > 0 || s.kept;
}

export function App({ snapshot: s, send, host }: AppProps) {
  const [hovered, setHovered] = useState<Element | null>(null);
  const [dragBox, setDragBox] = useState<AreaBox | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [composer, setComposer] = useState(false);
  const [followupFor, setFollowupFor] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [closed, setClosed] = useState(false);
  const pickerRef = useRef<Picker | null>(null);

  const annotations = s?.draft?.annotations ?? [];
  const count = annotations.length;
  const on = !!s && s.mode && s.signedIn && s.support.ok;

  // The request the next send refines: this preview's request, or "Add detail".
  const target: RequestView | null = useMemo(() => {
    if (!s) return null;
    if (s.preview) return s.preview.request;
    if (followupFor && s.request?.id === followupFor && canFollowUp(s.request)) return s.request;
    return null;
  }, [s, followupFor]);

  useEffect(() => {
    if (s?.mode) setClosed(false);
  }, [s?.mode]);
  useEffect(() => {
    if (count === 0) setComposer(false);
  }, [count]);
  useEffect(() => {
    if (followupFor && s?.request?.id !== followupFor) setFollowupFor(null);
  }, [s?.request?.id, followupFor]);

  const doSend = useCallback(() => {
    if (!s || count === 0 || s.sending) return;
    if (!composer) {
      setComposer(true);
      return;
    }
    if (target) {
      if (canFollowUp(target)) send({ t: "followup", requestId: target.id });
    } else if (s.draft?.title.trim()) {
      send({ t: "send", mode: s.sendMode });
    }
  }, [s, count, composer, target, send]);

  const escape = useCallback(() => {
    if (pop) setPop(null);
    else if (help) setHelp(false);
    else if (composer) setComposer(false);
    else if (s?.mode) send({ t: "exit" });
  }, [pop, help, composer, s?.mode, send]);

  // Latest handlers for the picker (created once).
  const handlers = useRef({ escape, doSend, setHelp });
  handlers.current = { escape, doSend, setHelp };

  useLayoutEffect(() => {
    const picker = new Picker(document, host, {
      onHover: setHovered,
      onPick: (el) => setPop({ kind: "new", el }),
      onEscape: () => handlers.current.escape(),
      onSendShortcut: () => handlers.current.doSend(),
      onHelp: () => handlers.current.setHelp(true),
      onAreaDrag: setDragBox,
      onAreaPick: (box, container) => setPop({ kind: "area", box, container, scroll: { x: window.scrollX, y: window.scrollY } }),
      onBusyClick: () => (host.shadowRoot?.querySelector(".popover textarea") as HTMLElement | null)?.focus(),
    });
    pickerRef.current = picker;
    return () => picker.stop();
  }, [host]);

  useLayoutEffect(() => {
    const picker = pickerRef.current!;
    if (on) picker.start();
    else {
      picker.stop();
      setPop((p) => (p?.kind === "new" || p?.kind === "area" ? null : p));
    }
  }, [on]);

  useLayoutEffect(() => {
    if (pickerRef.current) pickerRef.current.busy = !!pop || help;
  }, [pop, help]);

  usePreviewTitle(!!s?.preview);

  const observed = useMemo(() => (hovered ? [hovered] : []), [hovered]);
  const show = !!s && visible(s) && !closed;
  const tick = useLayoutTick(show && (count > 0 || !!hovered || !!pop || !!dragBox), observed);

  if (!s || !show) return null;

  const editing = pop?.kind === "edit" ? annotations.find((a) => a.id === pop.id) : undefined;
  let popBox: Box | null = null;
  if (pop?.kind === "new") popBox = pop.el.isConnected ? rectBox(pop.el) : null;
  if (pop?.kind === "area") {
    popBox = { ...pop.box, left: pop.box.left + pop.scroll.x - window.scrollX, top: pop.box.top + pop.scroll.y - window.scrollY };
  }
  if (editing) popBox = annotationBox(editing).box;
  const isNew = pop?.kind === "new" || pop?.kind === "area";

  let hoverBox: Box | null = on && !pop && hovered?.isConnected ? rectBox(hovered) : isNew ? popBox : null;
  let hoverLabel = hovered && on && !pop ? elementLabel(hovered) : null;
  if (on && !pop && dragBox) {
    hoverBox = dragBox;
    hoverLabel = `area · ${Math.round(dragBox.width)}×${Math.round(dragBox.height)}`;
  }

  return (
    <div
      class="root"
      data-tick={tick}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          escape();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          doSend();
        }
        e.stopPropagation();
      }}
      onKeyUp={(e) => e.stopPropagation()}
      onKeyPress={(e) => e.stopPropagation()}
    >
      {s.preview && <PreviewBanner r={s.preview.request} productionUrl={s.preview.productionUrl} send={send} />}
      <Outline box={hoverBox} label={hoverLabel} area={!!dragBox || pop?.kind === "area"} />
      <Pins
        annotations={annotations}
        tick={tick}
        draftNumber={isNew ? count + 1 : null}
        draftBox={isNew ? popBox : null}
        onOpen={(id) => setPop({ kind: "edit", id })}
      />
      {pop && popBox && (
        <CommentPopover
          key={pop.kind === "edit" ? pop.id : pop.kind}
          box={popBox}
          number={editing ? annotations.indexOf(editing) + 1 : count + 1}
          initial={editing?.comment ?? ""}
          editing={!!editing}
          onCancel={() => setPop(null)}
          onDelete={editing ? () => (send({ t: "draft.remove", id: editing.id }), setPop(null)) : undefined}
          onSave={(comment) => {
            if (pop.kind === "new") send({ t: "draft.add", annotation: { ...captureElement(pop.el, window), comment } });
            else if (pop.kind === "area") send({ t: "draft.add", annotation: { ...captureArea(pop.box, pop.container, window), comment } });
            else send({ t: "draft.edit", id: pop.id, comment });
            setPop(null);
          }}
        />
      )}
      <Dock
        s={s}
        send={send}
        composer={composer}
        setComposer={setComposer}
        target={target}
        setFollowupFor={setFollowupFor}
        onEditComment={(id) => setPop({ kind: "edit", id })}
        onHelp={() => setHelp(true)}
        onSend={doSend}
        onClose={() => setClosed(true)}
      />
      {s.preview && !s.firstPreviewNoticeSeen && (
        <PreviewNotice r={s.preview.request} onDone={(forever) => send({ t: "preview.noticeSeen", forever })} />
      )}
      {help && <ShortcutSheet onClose={() => setHelp(false)} />}
    </div>
  );
}
