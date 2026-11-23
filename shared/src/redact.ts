/** Query parameter names that may carry credentials. */
const SENSITIVE_PARAM = /token|key|secret|session|auth|code|password|sig/i;

export const REDACTED = "REDACTED";

/**
 * Make a page URL safe to publish: drops the fragment and redacts the values
 * of query parameters whose names look sensitive.
 */
export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    const hash = input.indexOf("#");
    return hash === -1 ? input : input.slice(0, hash);
  }
  url.hash = "";
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  const params = [...url.searchParams.entries()];
  if (params.some(([name]) => SENSITIVE_PARAM.test(name))) {
    const next = new URLSearchParams();
    for (const [name, value] of params) {
      next.append(name, SENSITIVE_PARAM.test(name) ? REDACTED : value);
    }
    url.search = next.toString();
  }
  return url.toString();
}
