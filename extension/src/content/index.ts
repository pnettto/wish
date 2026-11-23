import { isTerminalState } from "@web-issuer/shared";
import { h, render } from "preact";
import type { Snapshot } from "../messages";
import { App } from "./app/App";
import { createBridge } from "./app/bridge";
import css from "./styles.css?inline";

export const HOST_TAG = "web-issuer-overlay";

declare global {
  interface Window {
    __webIssuer?: { destroy(): void };
  }
}

/**
 * Content script (injected on toolbar click / ⌥⇧F, or registered for kept
 * sites and preview origins). Mounts the in-page UI in a shadow root, inside a
 * top-layer popover so page z-index and stacking can't cover it. All state
 * comes from the background as Snapshots; this script never calls the API.
 */
function init() {
  if (window.top !== window) return;
  if (window.__webIssuer) return;

  const host = document.createElement(HOST_TAG);
  host.setAttribute("data-web-issuer", "");
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const layer = document.createElement("div");
  layer.className = "layer";
  layer.setAttribute("popover", "manual");
  shadow.append(style, layer);
  document.documentElement.append(host);

  const showLayer = () => {
    try {
      if (layer.matches(":popover-open")) layer.hidePopover();
      layer.showPopover();
    } catch {
      // No popover API: the fixed host with max z-index still works.
      layer.classList.add("no-popover");
    }
  };
  showLayer();

  let snapshot: Snapshot | null = null;
  let wasMode = false;
  const draw = () => render(h(App, { snapshot, send: bridge.send, host }), layer);
  const bridge = createBridge(
    (s) => {
      snapshot = s;
      // Re-raise above any top-layer element the page opened since.
      if (s.mode && !wasMode) showLayer();
      wasMode = s.mode;
      const busy =
        !!s.sending ||
        (!!s.request && !isTerminalState(s.request.state)) ||
        (!!s.preview && !isTerminalState(s.preview.request.state));
      bridge.setLive(busy);
      draw();
    },
    () => destroy(),
  );

  function destroy() {
    render(null, layer);
    host.remove();
    delete window.__webIssuer;
  }

  window.__webIssuer = { destroy };
  draw();
}

init();
