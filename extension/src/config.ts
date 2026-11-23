/** Worker origin. Override at build time with VITE_API_BASE (e.g. http://localhost:8787). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) || "https://issuer.pnetto.store";

/**
 * Match pattern for preview deployments (UX-PLAN D3). Requested once as an
 * optional host permission so the preview banner can run there. Override with
 * VITE_PREVIEW_PATTERN for local testing (e.g. "http://127.0.0.1/*").
 */
export const PREVIEW_PATTERN: string =
  (import.meta.env.VITE_PREVIEW_PATTERN as string | undefined) || "https://*.pedro-535.workers.dev/*";

/** Undo window before a send is actually submitted. */
export const UNDO_MS = 5000;
