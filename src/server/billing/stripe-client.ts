import { env } from "cloudflare:workers";
import Stripe from "stripe";

import { fakeStripeFetch } from "./fake-stripe";

/**
 * The one Stripe client, and the switch between a real account and the local
 * stand-in.
 *
 * The rule is deliberately a single bit — *is `STRIPE_SECRET_KEY` set* — rather
 * than sniffing the key for `sk_test_` or a mock prefix. A test-mode key is a
 * real account: it talks to Stripe, mints real (test) objects, and fires real
 * webhooks at a real tunnel. Conflating "test mode" with "no Stripe at all" is
 * how someone ends up debugging a fake backend while holding perfectly good
 * credentials.
 */
export const isMockStripe = !env.STRIPE_SECRET_KEY;

/**
 * Stripe refuses to construct without a key, so the mock path needs one that
 * is obviously not a key. It never leaves this Worker: the fake backend does
 * not check `Authorization`, and no request goes out.
 */
const MOCK_SECRET_KEY = "sk_test_producer_mock_no_account";

/**
 * Signs and verifies the webhooks the checkout page delivers to the plugin.
 * Mock or not, this is used for real: `stripe.webhooks.constructEventAsync`
 * runs its actual HMAC check over the actual header, so a payload assembled by
 * `deliverStripeEvent` has to be signed correctly or the endpoint rejects it —
 * which is exactly the failure a real integration would hit.
 */
export const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET || "whsec_producer_mock";

/**
 * One per isolate, like the Gateway client: constructing it walks the whole
 * resource tree, and none of that depends on the request.
 *
 * `createFetchHttpClient` on both branches, not just the mock one — the Node
 * HTTP client the SDK would otherwise pick throws on Workers, where there are
 * no sockets to open. Passing `undefined` gives it the runtime's own `fetch`.
 */
export const stripe = new Stripe(env.STRIPE_SECRET_KEY || MOCK_SECRET_KEY, {
  httpClient: Stripe.createFetchHttpClient(isMockStripe ? fakeStripeFetch : undefined),
  // Nothing is retried against the fake backend (it cannot fail transiently),
  // and two attempts is Stripe's own recommendation for the real one.
  maxNetworkRetries: isMockStripe ? 0 : 2,
  // An extra request per isolate to a third party, reporting how long our calls
  // took. Off: it buys us nothing and the mock backend would answer it with a
  // 501 on every boot.
  telemetry: false,
  appInfo: { name: "producer" }
});
