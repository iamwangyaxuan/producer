import { env } from "cloudflare:workers";

import { auth } from "#/lib/auth";

import type { StripeObject } from "./fake-stripe";
import { stripeWebhookSecret } from "./stripe-client";

/**
 * Delivering the webhook Stripe would have sent.
 *
 * The mock backend has to close the loop somewhere, and this is the honest
 * place: the plugin learns that a checkout completed the same way it would in
 * production — a signed `POST /api/auth/stripe/webhook` carrying an event — so
 * `onCheckoutSessionCompleted`, the `subscription` row it updates, and the
 * `onSubscriptionComplete` hook that creates the organization are all the real
 * code paths, reached the real way. Nothing here is a shortcut past them.
 *
 * Two things are deliberately *not* faithful to Stripe, and both make this
 * strictly stronger for local use:
 *
 * - It is synchronous. Stripe queues webhooks and retries them for days; here
 *   the delivery finishes before the button that triggered it returns, so the
 *   page can tell the user what actually happened instead of "check back
 *   later". Code that reads the result afterwards must still not assume
 *   delivery succeeded — see the verification in `checkout.ts`.
 * - It never fails or duplicates. The plugin's handlers are written to be
 *   replay-safe and this exercises none of that, so the replay-safety the
 *   organization hook needs is verified by construction rather than by test.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The `Stripe-Signature` header, built the way Stripe builds it: HMAC-SHA256
 * over `<timestamp>.<payload>` keyed with the endpoint secret.
 *
 * This is genuine work, not decoration. The plugin verifies it with the SDK's
 * own `constructEventAsync`, which checks the digest and rejects a timestamp
 * more than five minutes old — so a wrong secret or a re-serialized payload
 * fails here exactly as it would against production.
 */
async function signPayload(payload: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(stripeWebhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`)
  );

  return `t=${timestamp},v1=${toHex(signature)}`;
}

/**
 * Posts one event to the plugin's webhook endpoint and resolves once it has
 * been fully handled.
 *
 * `auth.handler` rather than `fetch` at our own URL: it is the same function
 * the route in `routes/api/auth/$.ts` calls, so the event goes through the
 * whole plugin pipeline without a second HTTP hop — no loopback that has to
 * resolve its own hostname, no subrequest budget, and no way for the delivery
 * to land in a different isolate than the one waiting on it.
 */
export async function deliverStripeEvent(type: string, object: StripeObject) {
  const created = Math.floor(Date.now() / 1000);

  const payload = JSON.stringify({
    id: `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    object: "event",
    // Null rather than a version string copied off the SDK: the plugin does not
    // read it, and a stale value here would be a claim about which API shape
    // the payload follows that nothing keeps true.
    api_version: null,
    created,
    data: { object },
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type
  });

  const response = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/stripe/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": await signPayload(payload, created)
      },
      body: payload
    })
  );

  if (!response.ok) {
    // The endpoint answers 200 for events it handled and for events it chose to
    // ignore, so anything else is the signature check or the plugin itself
    // refusing — worth surfacing rather than swallowing, because both mean the
    // subscription row was never updated.
    throw new Error(`Stripe webhook ${type} was rejected (${response.status}).`);
  }
}
