import type { ContentMessage, PanelMessage } from "../messages";
import { Picker } from "./picker";

declare global {
  interface Window {
    __webIssuer?: { picker: Picker; handle(message: PanelMessage): unknown };
  }
}

/**
 * Injected on demand by the side panel (chrome.scripting.executeScript).
 * Guarded so repeated injection reuses the same instance.
 */
function init() {
  if (window.top !== window) return;
  if (window.__webIssuer) return;

  const send = (message: ContentMessage) => {
    try {
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // Extension reloaded; nothing to do.
    }
  };

  const picker = new Picker(document, {
    onAnnotation: (annotation) => send({ type: "wi:annotation", pageUrl: location.href, annotation }),
    onActiveChange: (active) => send({ type: "wi:picker-state", pageUrl: location.href, active }),
  });

  const handle = (message: PanelMessage) => {
    switch (message.type) {
      case "wi:start":
        picker.start();
        return { ok: true };
      case "wi:stop":
        picker.stop();
        return { ok: true };
      case "wi:pins":
        picker.setPins(message.pins);
        return { ok: true };
      case "wi:highlight":
        return { ok: true, found: picker.highlight(message.pin) };
      case "wi:ping":
        return { ok: true, active: picker.isActive };
      default:
        return undefined;
    }
  };

  chrome.runtime.onMessage.addListener((message: PanelMessage, _sender, sendResponse) => {
    const result = handle(message);
    if (result !== undefined) sendResponse(result);
  });

  window.__webIssuer = { picker, handle };
}

init();
