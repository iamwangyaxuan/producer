import { eq } from "drizzle-orm";

import { getDB, schema } from "#/db";
import { SEAT_PLANS } from "#/lib/plans";
import type { SeatPlan } from "#/lib/plans";

import { expireCheckoutSession, readObject, settleCheckoutSession } from "./fake-stripe";
import type { StripeObject } from "./fake-stripe";
import { isMockStripe } from "./stripe-client";
import { deliverStripeEvent } from "./webhook";

/**
 * The pages Stripe would have hosted.
 *
 * A real integration sends the browser to `checkout.stripe.com` and gets it
 * back at `success_url`; with no Stripe account there is nowhere to send it, so
 * the app hosts the step itself. Everything on either side of this file is
 * unchanged from the real flow — the session was minted by the plugin through
 * the Stripe SDK, and pressing "Pay" ends in a signed webhook the plugin
 * handles — which is what keeps this a stand-in for one screen rather than a
 * parallel implementation of billing.
 */

/** Enough to price the order and name what it buys. */
export interface CheckoutOrder {
  id: string;
  status: "open" | "complete" | "expired";
  organizationName: string;
  plan: SeatPlan;
  seats: number;
  total: number;
  currency: string;
  /** Absolute, with Stripe's `{CHECKOUT_SESSION_ID}` template already filled. */
  successUrl: string;
  cancelUrl: string;
  /** Set once the purchase has produced an organization. */
  organizationId: string | null;
  /**
   * Whether this checkout is against the stand-in account rather than Stripe.
   *
   * It travels with the order because the page has to say so out loud. A screen
   * that asks for money and takes none is the one thing here that could mislead
   * someone into thinking they had paid — or into typing a real card number
   * into a form that has no business seeing one.
   */
  mock: boolean;
}

function stringField(source: StripeObject, key: string) {
  const value = source[key];

  return typeof value === "string" ? value : null;
}

function metadataField(session: StripeObject, key: string) {
  const metadata = session.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;

  const value = (metadata as Record<string, unknown>)[key];

  return typeof value === "string" ? value : null;
}

const SEAT_PLAN_BY_PRICE = new Map<string, SeatPlan>(
  SEAT_PLANS.map((plan) => [plan.priceId, plan])
);

/**
 * The single line every checkout in this app has: a seat price and a quantity.
 * Written as a search rather than `data[0]` because the plugin is free to add
 * line items we did not ask for, and the plan line is the one being read.
 */
function readSeatLine(session: StripeObject) {
  const lineItems = session.line_items as { data?: unknown } | undefined;
  const rows = Array.isArray(lineItems?.data) ? lineItems.data : [];

  for (const row of rows) {
    const line = row as { price?: { id?: unknown }; quantity?: unknown };
    const priceId = typeof line.price?.id === "string" ? line.price.id : null;
    if (!priceId) continue;

    const plan = SEAT_PLAN_BY_PRICE.get(priceId);
    if (!plan) continue;

    return { plan, seats: typeof line.quantity === "number" ? line.quantity : 1 };
  }

  return null;
}

/**
 * Stripe substitutes this in `success_url` when it redirects; the plugin builds
 * its callback around the template, so nothing downstream works until it does.
 */
function fillSessionTemplate(url: string, sessionId: string) {
  return url.replaceAll("{CHECKOUT_SESSION_ID}", sessionId);
}

/**
 * Loads a session and refuses it to anyone but the person who started it.
 *
 * The owner comes from `metadata.userId`, which the plugin stamps on every
 * session it creates from the authenticated caller — so it is a server-side
 * fact about the checkout, not something the browser gets to assert. Anything
 * that does not match reads as "no such checkout", the same answer a made-up id
 * gets.
 */
async function loadSession(sessionId: string, userId: string) {
  if (!sessionId.startsWith("cs_")) return null;

  const session = await readObject(sessionId);
  if (!session || session.object !== "checkout.session") return null;
  if (metadataField(session, "userId") !== userId) return null;

  return session;
}

function sessionStatus(session: StripeObject): CheckoutOrder["status"] {
  const status = stringField(session, "status");

  return status === "complete" || status === "expired" ? status : "open";
}

async function describe(session: StripeObject): Promise<CheckoutOrder | null> {
  const line = readSeatLine(session);
  const referenceId = stringField(session, "client_reference_id");
  const successUrl = stringField(session, "success_url");
  const cancelUrl = stringField(session, "cancel_url");

  if (!line || !referenceId || !successUrl || !cancelUrl) return null;

  const db = getDB();

  // The name lives on the draft rather than in Stripe metadata: metadata is a
  // flat string map with a length limit that an organization name can exceed,
  // and the draft is already the record of what was ordered.
  const [draft] = await db
    .select({ name: schema.organizationDraft.name })
    .from(schema.organizationDraft)
    .where(eq(schema.organizationDraft.id, referenceId))
    .limit(1);

  const [organization] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, referenceId))
    .limit(1);

  const id = session.id as string;

  return {
    id,
    status: sessionStatus(session),
    organizationName: draft?.name ?? "New organization",
    plan: line.plan,
    seats: line.seats,
    total: line.plan.unitAmount * line.seats,
    currency: line.plan.currency,
    successUrl: fillSessionTemplate(successUrl, id),
    cancelUrl,
    organizationId: organization?.id ?? null,
    mock: isMockStripe
  };
}

export async function readCheckoutOrder(sessionId: string, userId: string) {
  const session = await loadSession(sessionId, userId);

  return session ? await describe(session) : null;
}

export class CheckoutError extends Error {}

/**
 * Settles the checkout and waits for the organization it was for to exist.
 *
 * The verification at the end is not belt and braces. The plugin's webhook
 * handler wraps `onSubscriptionComplete` in a `try/catch` that logs and returns
 * 200, so a failure to create the organization is indistinguishable from
 * success at the HTTP layer — reading the row back is the only way this can
 * tell the user the truth. A real Stripe integration has the same problem for a
 * different reason (delivery is asynchronous and may be retried minutes later),
 * so the check belongs here either way.
 *
 * The money is already committed at that point, which is why the failure
 * message says so: the subscription is `active` and paid for, and pressing the
 * button again is safe — `settleCheckoutSession` returns the same subscription
 * and `applyPurchasedOrganization` will try to create the same organization.
 */
export async function payCheckoutOrder(sessionId: string, userId: string) {
  const session = await loadSession(sessionId, userId);
  if (!session) throw new CheckoutError("That checkout no longer exists.");

  if (sessionStatus(session) === "expired") {
    throw new CheckoutError("That checkout was cancelled. Start a new one to try again.");
  }

  const settled = await settleCheckoutSession(sessionId);
  if (!settled) throw new CheckoutError("That checkout could not be completed.");

  await deliverStripeEvent("checkout.session.completed", settled.session);

  const order = await describe(settled.session);
  if (!order) throw new CheckoutError("That checkout could not be completed.");

  if (!order.organizationId) {
    throw new CheckoutError(
      "The payment went through, but the organization could not be created. " +
        "Nothing was charged twice — try again."
    );
  }

  return order;
}

/**
 * Walking away. The draft is closed with it, so the reference id it reserved
 * stops authorizing new checkouts — an abandoned order should not leave a
 * usable claim on a tenant id lying around.
 */
export async function abandonCheckoutOrder(sessionId: string, userId: string) {
  const session = await loadSession(sessionId, userId);
  if (!session) throw new CheckoutError("That checkout no longer exists.");

  const order = await describe(session);
  if (!order) throw new CheckoutError("That checkout could not be read.");

  // A paid session is not abandonable: the organization exists and the
  // subscription is live, so the only sensible thing left is to go look at it.
  if (order.status === "complete") return order;

  await expireCheckoutSession(sessionId);

  const referenceId = stringField(session, "client_reference_id");

  if (referenceId) {
    await getDB()
      .update(schema.organizationDraft)
      .set({ status: "canceled" })
      .where(eq(schema.organizationDraft.id, referenceId));
  }

  return { ...order, status: "expired" as const };
}
