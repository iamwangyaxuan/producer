import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";

import { getDB, schema } from "#/db";
import type { CreditTopupStatus } from "#/db/schema";
import { centsToMicro, formatUsd } from "#/lib/money";
import { isSellableTopup, quoteTopup, TOPUP_FEE_BPS } from "#/lib/pricing";

import { expireCheckoutSession, settlePaymentSession } from "./fake-stripe";
import { isMockStripe, stripe } from "./stripe-client";
import { deliverStripeEvent } from "./webhook";

/**
 * Buying credit.
 *
 * Deliberately *not* routed through `@better-auth/stripe`: that plugin sells
 * subscriptions and only subscriptions — it hardcodes `mode: "subscription"`
 * when it creates a session, and its `onCheckoutSessionCompleted` handler
 * reaches for `session.subscription` on every completed checkout that is not a
 * setup. A top-up is a one-time payment, so it is created here, with the same
 * Stripe client, and settled on `payment_intent.succeeded` — the one event the
 * plugin passes straight to `onEvent` without trying to interpret it first.
 *
 * The shape follows `checkout.ts` closely on purpose: a local row minted before
 * anything is charged, a Stripe session that names it, and a page that either
 * pays or walks away. What differs is which record is authoritative —
 * `credit_topup` holds both amounts, and the webhook credits *that row* rather
 * than whatever number the event carries. The event says what was charged; only
 * the row says what was bought.
 *
 * An order names **two** parties, and they are not the same one: the credit
 * lands in an organization's wallet, while the charge goes to a person's card.
 * Stripe only knows the second — `customerType` is `user` and there is one
 * customer per human — so "who is paying" and "what is being paid for" have to
 * be carried separately, exactly as the seat checkout carries `referenceId`
 * beside its customer.
 */

/** The currency credit is sold in, matching the seat plans and the Gateway. */
const CURRENCY = "usd";

export class TopupError extends Error {}

/**
 * The Stripe customer for this person, made on first purchase.
 *
 * The same column the subscription plugin uses, and read before it is written
 * so the two paths converge on one customer rather than accumulating one per
 * feature. The plugin does the same lookup from its own upgrade endpoint; there
 * is no exported helper to borrow (the package exports exactly one symbol), so
 * this is a second implementation of a five-line idea rather than a second
 * source of truth — the column is the truth.
 *
 * The write is guarded on the column still being null, so two purchases started
 * at the same moment cannot each overwrite the other's customer. The loser's
 * customer is left orphaned in Stripe, which costs nothing and is visible.
 */
async function ensureStripeCustomer(user: { id: string; email: string; name: string }) {
  const db = getDB();

  const [existing] = await db
    .select({ stripeCustomerId: schema.user.stripeCustomerId })
    .from(schema.user)
    .where(eq(schema.user.id, user.id))
    .limit(1);

  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user.id, customerType: "user" }
  });

  const [claimed] = await db
    .update(schema.user)
    .set({ stripeCustomerId: customer.id })
    .where(and(eq(schema.user.id, user.id), isNull(schema.user.stripeCustomerId)))
    .returning({ stripeCustomerId: schema.user.stripeCustomerId });

  if (claimed?.stripeCustomerId) return claimed.stripeCustomerId;

  // Somebody else's create landed first. Theirs is the one the column names, so
  // theirs is the one this checkout uses.
  const [raced] = await db
    .select({ stripeCustomerId: schema.user.stripeCustomerId })
    .from(schema.user)
    .where(eq(schema.user.id, user.id))
    .limit(1);

  return raced?.stripeCustomerId ?? customer.id;
}

/** Stripe wants absolute URLs, and better-auth is not in this path to make them. */
function absolute(path: string) {
  return new URL(path, env.BETTER_AUTH_URL).toString();
}

export interface StartedTopup {
  /** Where the browser goes — Stripe's page, or the local stand-in's. */
  url: string;
  topupId: string;
}

/**
 * Starts a top-up for an organization: price it, write the order, then ask
 * Stripe for a page.
 *
 * Whether this caller may spend on this organization's behalf is settled before
 * anything reaches here — see `requireBillingAccess` in `lib/credits.ts`. This
 * function trusts the pair it is handed, the same way every other server-layer
 * write in this app trusts the scope its caller resolved.
 *
 * The order row lands *before* the session so the session can name it — the
 * PaymentIntent's metadata is what the webhook has to work from, and metadata
 * that pointed at a row written afterwards would leave a window where a
 * payment arrived for an order nothing could find.
 *
 * The fee rate is stamped on the row from the constant rather than read back
 * from it later: what someone agreed to is the schedule that was published at
 * the moment they agreed, and this app is free to change the published one
 * tomorrow.
 */
export async function startTopup(
  organizationId: string,
  user: { id: string; email: string; name: string },
  credit: number
): Promise<StartedTopup> {
  if (!isSellableTopup(credit)) throw new TopupError("That is not an amount we can add.");

  const quote = quoteTopup(credit, TOPUP_FEE_BPS);
  const db = getDB();

  const [order] = await db
    .insert(schema.creditTopup)
    .values({
      organizationId,
      userId: user.id,
      creditAmount: quote.credit,
      chargeAmount: quote.chargeCents,
      currency: CURRENCY,
      feeRateBps: quote.feeRateBps
    })
    .returning({ id: schema.creditTopup.id });

  const customer = await ensureStripeCustomer(user);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer,
    client_reference_id: order.id,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: quote.chargeCents,
          product_data: {
            // What appears on the Stripe receipt, so it says what was bought
            // rather than what was charged — the fee is a line in this app, and
            // a receipt reading "$105 of credit" would be wrong.
            name: `Producer credit · ${formatUsd(quote.credit)}`
          }
        }
      }
    ],
    // The webhook's only handle on this order. `metadata` on the session is not
    // enough: `payment_intent.succeeded` carries the PaymentIntent, not the
    // session that created it.
    payment_intent_data: {
      metadata: { topupId: order.id, userId: user.id, organizationId }
    },
    metadata: { topupId: order.id, userId: user.id, organizationId },
    success_url: absolute("/billing?topup=paid"),
    cancel_url: absolute("/billing")
  });

  await db
    .update(schema.creditTopup)
    .set({ stripeSessionId: session.id })
    .where(eq(schema.creditTopup.id, order.id));

  if (!session.url) throw new TopupError("Could not start the checkout.");

  return { url: session.url, topupId: order.id };
}

export interface TopupOrder {
  id: string;
  status: CreditTopupStatus;
  /** Micro-dollars that will land in the wallet. */
  credit: number;
  /** Micro-dollars of handling fee. */
  fee: number;
  /** Cents charged — the number on the button. */
  chargeCents: number;
  currency: string;
  feeRateBps: number;
  /** Same warning the seat checkout carries, for the same reason. */
  mock: boolean;
}

function describe(row: typeof schema.creditTopup.$inferSelect): TopupOrder {
  const chargeMicro = centsToMicro(row.chargeAmount);

  return {
    id: row.id,
    status: row.status,
    credit: row.creditAmount,
    // Derived rather than stored: the two amounts on the row are what was
    // agreed, and a third column holding their difference is a column that can
    // disagree with them.
    fee: chargeMicro - row.creditAmount,
    chargeCents: row.chargeAmount,
    currency: row.currency,
    feeRateBps: row.feeRateBps,
    mock: isMockStripe
  };
}

/**
 * The order behind a checkout session, refused to anyone but the person who
 * started it — the same answer a made-up id gets, so the two are
 * indistinguishable from outside.
 *
 * Matched on the **payer**, not on the organization: this page is where
 * somebody's own card is about to be charged, and it is theirs to see or
 * abandon even if their role in the organization has changed since they opened
 * it. What the money buys is still the organization's, and that is decided by
 * the row rather than by whoever is looking at it.
 */
async function loadOrder(sessionId: string, userId: string) {
  if (!sessionId.startsWith("cs_")) return null;

  const [row] = await getDB()
    .select()
    .from(schema.creditTopup)
    .where(
      and(eq(schema.creditTopup.stripeSessionId, sessionId), eq(schema.creditTopup.userId, userId))
    )
    .limit(1);

  return row ?? null;
}

export async function readTopupOrder(sessionId: string, userId: string) {
  const row = await loadOrder(sessionId, userId);

  return row ? describe(row) : null;
}

/**
 * Paying, on the stand-in account.
 *
 * Settle the session, deliver the signed event, then **read the row back** —
 * for the same reason `payCheckoutOrder` does. The plugin's webhook endpoint
 * answers 200 for events it handled and for events it ignored, so the response
 * code says nothing about whether the credit landed; the balance does. A real
 * Stripe integration has the same problem from the other direction, where
 * delivery is asynchronous, so the check belongs here either way.
 */
export async function payTopupOrder(sessionId: string, userId: string): Promise<TopupOrder> {
  const row = await loadOrder(sessionId, userId);
  if (!row) throw new TopupError("That top-up no longer exists.");

  if (row.status === "paid") return describe(row);
  if (row.status === "canceled") {
    throw new TopupError("That top-up was cancelled. Start a new one to try again.");
  }

  const settled = await settlePaymentSession(sessionId);
  if (!settled) throw new TopupError("That top-up could not be completed.");

  await deliverStripeEvent("payment_intent.succeeded", settled.paymentIntent);

  const applied = await loadOrder(sessionId, userId);

  if (!applied || applied.status !== "paid") {
    throw new TopupError(
      "The payment went through, but the credit was not added. " +
        "Nothing was charged twice — try again, or contact us with this page open."
    );
  }

  return describe(applied);
}

/** Walking away. Closes the Stripe session as well as the local order. */
export async function abandonTopupOrder(sessionId: string, userId: string): Promise<TopupOrder> {
  const row = await loadOrder(sessionId, userId);
  if (!row) throw new TopupError("That top-up no longer exists.");

  // A paid order is not abandonable: the money is in and the credit with it.
  if (row.status === "paid") return describe(row);

  await expireCheckoutSession(sessionId);

  await getDB()
    .update(schema.creditTopup)
    .set({ status: "canceled" })
    .where(and(eq(schema.creditTopup.id, row.id), eq(schema.creditTopup.status, "pending")));

  return { ...describe(row), status: "canceled" };
}
