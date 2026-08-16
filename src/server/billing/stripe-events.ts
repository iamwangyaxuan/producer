import type Stripe from "stripe";

import { applyPaidTopup } from "./credits";

/**
 * The events this app handles that the subscription plugin does not.
 *
 * Reached through the plugin's `onEvent`, which runs for **every** event on the
 * webhook — for the four it knows, after its own handler; for everything else,
 * as the only handler. `payment_intent.succeeded` falls in the second group,
 * which is exactly why credit is settled on it rather than on
 * `checkout.session.completed`: the plugin's handler for that one reaches for
 * `session.subscription` on any completed checkout that is not a setup, and a
 * one-time payment has none. It survives that (its own try/catch logs and
 * returns) but it costs a doomed round trip to Stripe and an error line per
 * top-up, for nothing.
 *
 * One webhook endpoint, one signing secret, one place signatures are verified —
 * all of which the plugin already does properly — and a handler here that only
 * has to know what an event means.
 *
 * A leaf on the import graph, so `auth.ts` can reach it: it imports the wallet
 * and the Stripe types and nothing else. Anything that pulled `auth` back in
 * would close a cycle through the very module that configures the plugin.
 */

function metadataString(metadata: Stripe.Metadata | null | undefined, key: string) {
  const value = metadata?.[key];

  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Throws on failure, and that is the contract with Stripe rather than an
 * oversight: the plugin turns anything thrown here into a non-200, which is how
 * Stripe is told to redeliver. For a credit grant that is the direction to
 * fail in — {@link applyPaidTopup} is idempotent, so a redelivery of one that
 * did land changes nothing, while swallowing a failure would lose someone's
 * money silently.
 */
export async function handleStripeEvent(event: Stripe.Event) {
  if (event.type !== "payment_intent.succeeded") return;

  const intent = event.data.object;
  const topupId = metadataString(intent.metadata, "topupId");

  // Not ours. A Stripe account carries payments this app did not start — and
  // will carry more as it grows — so an unrecognised one is ordinary rather
  // than an error to raise.
  if (!topupId) return;

  const applied = await applyPaidTopup({
    topupId,
    paymentIntentId: intent.id,
    amountReceivedCents: intent.amount_received
  });

  if (!applied) {
    // A `topupId` that names no order. Worth a line rather than a throw: a
    // retry cannot make the row exist, so failing the delivery would only ask
    // Stripe to repeat this for days.
    console.error(`payment ${intent.id} named top-up ${topupId}, which does not exist`);

    return;
  }

  console.log(
    `credited ${applied.credited} to organization ${applied.organizationId} ` +
      `from top-up ${applied.topupId}`
  );
}
