/** Worker origin. Override at build time with VITE_API_BASE (e.g. http://localhost:8787). */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) || "https://issuer.pnetto.store";
