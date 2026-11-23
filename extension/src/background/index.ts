import { isTerminalState, type RequestView } from "@web-issuer/shared";
import { API_BASE } from "../config";
import { chromeStore, KEYS } from "../storage";
import { activeRequests, loadRequests, saveRequest } from "../tracking";

const ALARM = "poll-requests";

function setup() {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

/** Poll active requests while the panel may be closed; badge on completion. */
async function poll() {
  const session = await chromeStore.get<string>(KEYS.session);
  if (!session) return;
  const active = activeRequests(await loadRequests(chromeStore));
  for (const req of active) {
    try {
      const res = await fetch(`${API_BASE}/requests/${encodeURIComponent(req.id)}`, {
        headers: { Authorization: `Bearer ${session}` },
      });
      if (res.status === 401) {
        await chromeStore.remove(KEYS.session);
        return;
      }
      if (!res.ok) continue;
      const view = (await res.json()) as RequestView;
      await saveRequest(chromeStore, view);
      if (isTerminalState(view.state) && !isTerminalState(req.state)) {
        const ok = view.state === "succeeded" || view.state === "live";
        await chrome.action.setBadgeBackgroundColor({ color: ok ? "#4c7a5a" : "#9a6b2f" });
        await chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
      }
    } catch {
      // Offline; try again on the next alarm.
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void poll();
});
