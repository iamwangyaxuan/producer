import { createGateway } from "ai";
import { env } from "cloudflare:workers";

import type { GatewayKeySource } from "#/db/schema";
import { readGatewayKey } from "#/server/generation/gateway-key";

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
 * Which key gets used is now a question with two answers — see
 * {@link resolveGateway}.
 */

/**
 * Clients, one per distinct key.
 *
 * Built once and kept, because constructing one walks the whole resource tree
 * and none of that depends on the request. Keyed by the credential itself so an
 * organization on its own key reuses its client the same way the system one is
 * reused; the map is bounded in practice by how many organizations a single
 * isolate happens to serve, and the secrets in it are already in this isolate's
 * memory by the time a request is being made with them.
 */
const clients = new Map<string, ReturnType<typeof createGateway>>();

function clientFor(apiKey: string) {
  let client = clients.get(apiKey);

  if (!client) {
    client = createGateway({ apiKey });
    clients.set(apiKey, client);
  }

  return client;
}

export interface ResolvedGateway {
  gateway: ReturnType<typeof createGateway>;
  /**
   * Whose credentials this is. It decides more than routing: a call on the
   * organization's own key is billed to *their* Vercel account, so this app
   * does not charge its wallet for it — see `quoteFor` in `generate-asset.ts`.
   */
  source: GatewayKeySource;
}

/**
 * The gateway this organization's requests go out on, or null when there is
 * none to be had.
 *
 * Their own key wins over ours, which is the entire point of letting one be
 * uploaded: an organization that supplies a key is asking to be billed by
 * Vercel directly rather than by us. The fallback order is therefore fixed and
 * has no configuration of its own — "use my key" is expressed by there being a
 * key, not by a second switch that could disagree with it.
 *
 * Null rather than a throw, because "no key anywhere" is the ordinary state of
 * a fresh checkout and every caller already has somewhere sensible to go:
 * naming falls back to a derived title, generation falls back to the sample
 * provider, and the composer quotes nothing. A throw here would turn "you have
 * not set this up yet" into a broken canvas.
 */
export async function resolveGateway(organizationId: string): Promise<ResolvedGateway | null> {
  const own = await readGatewayKey(organizationId);

  if (own) return { gateway: clientFor(own), source: "own" };

  if (env.AI_GATEWAY_API_KEY) {
    return { gateway: clientFor(env.AI_GATEWAY_API_KEY), source: "system" };
  }

  return null;
}

/**
 * Whether *this deployment* has a key of its own — the question the wallet
 * asks, and the only one that can be answered without a database read.
 *
 * It is not "can this organization generate": an organization with its own key
 * can generate on a deployment that has none. It is the narrower fact that
 * decides whether a generation with no organization key attached would be
 * billed to the balance.
 */
export function hasSystemGatewayKey() {
  return Boolean(env.AI_GATEWAY_API_KEY);
}
