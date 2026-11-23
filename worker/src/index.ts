import { handle } from "./app";
import type { Env } from "./env";

export { RequestLive } from "./request-do";

export default {
  fetch(request, env) {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
