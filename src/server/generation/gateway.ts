import { createGateway } from "ai";
import { env } from "cloudflare:workers";

/**
 * The one client every model request in this app goes through.
 *
 * Vercel's AI Gateway is a single endpoint in front of every vendor, which is
 * what lets the catalogue name models from six companies without this codebase
 * holding six SDKs and six sets of credentials. One key, one bill, one place a
 * request can be traced — and the model id is data (`creator/model`) rather
 * than a choice of import, which is the whole reason the catalogue can be a
 * plain list.
 *
 * The key has to be handed over explicitly. The SDK's default instance reads
 * `process.env.AI_GATEWAY_API_KEY`, and this runs on Workers, where the
 * environment is a binding rather than a process — `process.env` is empty here
 * even with `nodejs_compat`, so the default instance would authenticate with
 * nothing and every call would come back 401.
 *
 * Built once per isolate rather than per request: `env` is fixed for the
 * isolate's life, so a second instance would be an identical object and a
 * fresh connection pool.
 */
let client: ReturnType<typeof createGateway> | null = null;

/**
 * The gateway, or null when no key is configured.
 *
 * Null rather than a throw, because "no key" is the ordinary state of a fresh
 * checkout and every caller already has somewhere sensible to go: naming falls
 * back to a derived title, generation falls back to the sample provider. A
 * throw here would turn "you have not set this up yet" into a broken canvas.
 */
export function getGateway() {
  if (!env.AI_GATEWAY_API_KEY) return null;

  client ??= createGateway({ apiKey: env.AI_GATEWAY_API_KEY });

  return client;
}
