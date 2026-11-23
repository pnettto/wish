import { PREVIEW_PATTERN } from "../config";
import { originPattern } from "../page";

const KEPT_ID = "wi-kept-sites";
const PREVIEW_ID = "wi-previews";

/** Inject the content script into a tab's top frame (guarded against re-entry in the script itself). */
export async function inject(tabId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function hasOrigins(origins: string[]): Promise<boolean> {
  return chrome.permissions.contains({ origins });
}

/**
 * Persistent content scripts for "Keep on for this site" origins and for the
 * preview pattern, limited to what the user granted.
 */
export async function reconcileRegistrations(keptOrigins: string[]): Promise<void> {
  const kept: string[] = [];
  for (const origin of keptOrigins) {
    const pattern = originPattern(origin);
    if (await hasOrigins([pattern])) kept.push(pattern);
  }
  const previews = await hasOrigins([PREVIEW_PATTERN]);

  const wanted: chrome.scripting.RegisteredContentScript[] = [];
  if (kept.length > 0) {
    wanted.push({ id: KEPT_ID, matches: kept, js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true });
  }
  if (previews) {
    wanted.push({ id: PREVIEW_ID, matches: [PREVIEW_PATTERN], js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true });
  }

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [KEPT_ID, PREVIEW_ID] });
  if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (wanted.length > 0) await chrome.scripting.registerContentScripts(wanted);
}
