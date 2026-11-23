import { KEYS } from "../storage";
import { Hub } from "./hub";
import { reconcileRegistrations } from "./injection";

const ALARM = "poll-requests";
const hub = new Hub();

async function setup() {
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  const kept = ((await chrome.storage.local.get(KEYS.keptSites))[KEYS.keptSites] ?? []) as string[];
  await reconcileRegistrations(kept).catch((err) => console.error("register content scripts", err));
}

chrome.runtime.onInstalled.addListener((details) => {
  void setup();
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => void setup());

chrome.action.onClicked.addListener((tab) => {
  void chrome.action.setBadgeText({ text: "" });
  void hub.toggle(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  const run = async (t: chrome.tabs.Tab | undefined) => {
    if (!t) [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!t) return;
    if (command === "toggle-feedback") await hub.toggle(t);
    if (command === "toggle-preview") await hub.swapActive(t);
  };
  void run(tab);
});

chrome.runtime.onConnect.addListener((port) => hub.connect(port));

/** Messages from extension pages (settings / grant window). */
chrome.runtime.onMessage.addListener((msg: { t?: string; granted?: boolean; windowId?: number }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith("http")) return;
  if (msg.t === "grant.done" && typeof msg.windowId === "number") {
    void hub.grantResult(msg.windowId, !!msg.granted).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.t === "settings.changed") {
    hub.resetRepos();
    void reconcileAll().then(() => hub.schedulePush());
  }
  return undefined;
});

async function reconcileAll() {
  const kept = ((await chrome.storage.local.get(KEYS.keptSites))[KEYS.keptSites] ?? []) as string[];
  await reconcileRegistrations(kept).catch(() => undefined);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEYS.session]) hub.resetRepos();
  hub.schedulePush();
});

chrome.permissions.onAdded.addListener(() => void reconcileAll());
chrome.permissions.onRemoved.addListener(() => void reconcileAll());

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId === 0) hub.urlChanged(d.tabId, d.url);
});
chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId === 0) void hub.navigated(d.tabId, d.url);
});

chrome.tabs.onRemoved.addListener((tabId) => hub.tabClosed(tabId));
chrome.windows.onRemoved.addListener((windowId) => hub.windowClosed(windowId));
chrome.notifications.onClicked.addListener((id) => void hub.notificationClicked(id));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void hub.poll();
});
