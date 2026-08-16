import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";

import { getDB, schema } from "#/db";
import { findSeatPlan, SEAT_PLANS } from "#/lib/plans";

/**
 * A Stripe account that does not exist.
 *
 * The seam is the *transport*, not the SDK: `@better-auth/stripe` is wired up
 * for real, holding a real `Stripe` client, calling real methods — this file
 * only answers the HTTP requests that client makes instead of letting them
 * reach `api.stripe.com`. Everything above it (the plugin's endpoints, its
 * webhook handling, the `subscription` table, `authClient.subscription.*`) is
 * production code exercising a production code path.
 *
 * Faking one layer lower — handing the plugin a hand-written object that
 * quacks like `Stripe` — would have been less work and much less useful: the
 * shapes the plugin actually depends on are the wire shapes, and a stub built
 * from what we *think* it reads goes stale the moment the plugin reads one more
 * field. Here, anything the SDK can parse, the plugin gets.
 *
 * What is deliberately not modelled: payment methods, taxes, proration,
 * invoices, and failure. Every checkout here succeeds the instant someone
 * presses the button, because the point is to exercise the flow around the
 * payment, not the payment.
 */

/** Stripe ids are prefix + opaque tail; the tail only has to be unique. */
function stripeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

/**
 * One billing period on from `from`, in Stripe's units.
 *
 * Calendar arithmetic rather than a fixed number of days: a monthly
 * subscription bought on the 31st renews on the 30th of a 30-day month, which
 * is what `Date` does on its own when the day overflows.
 */
function periodEnd(from: number, interval: "month" | "year") {
  const date = new Date(from * 1000);

  if (interval === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);

  return Math.floor(date.getTime() / 1000);
}

/* -------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Stripe posts `application/x-www-form-urlencoded` with bracketed paths —
 * `line_items[0][price]=price_x`, `metadata[userId]=…` — so the body has to be
 * un-flattened before any of it can be read.
 *
 * Numeric segments stay object keys rather than becoming array indices. Nothing
 * downstream cares about the difference (`Object.values` reads a list either
 * way) and it sidesteps the one thing that does bite: a body that skips an
 * index would otherwise produce a sparse array with holes to guard against.
 */
type FormValue = string | FormObject;
interface FormObject {
  [key: string]: FormValue;
}

function keyPath(key: string) {
  const [head, ...rest] = key.split("[");

  return [head, ...rest.map((segment) => segment.replace("]", ""))];
}

function parseForm(body: string): FormObject {
  const parsed: FormObject = {};

  for (const [key, value] of new URLSearchParams(body)) {
    const path = keyPath(key);
    let cursor = parsed;

    for (const segment of path.slice(0, -1)) {
      const next = cursor[segment];
      // A scalar already sitting where a branch has to go means the body
      // disagrees with itself; the later, deeper write is the one kept.
      cursor = typeof next === "object" ? next : (cursor[segment] = {});
    }

    cursor[path[path.length - 1]] = value;
  }

  return parsed;
}

function formString(value: FormValue | undefined) {
  return typeof value === "string" ? value : undefined;
}

function formObject(value: FormValue | undefined): FormObject {
  return typeof value === "object" && value !== null ? value : {};
}

/** Stripe metadata is flat and all-strings, which is what the plugin assumes. */
function metadataOf(value: FormValue | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(formObject(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

/* -------------------------------------------------------------------------- */
/* Object store                                                               */
/* -------------------------------------------------------------------------- */

export type StripeObject = Record<string, unknown>;

async function putObject(id: string, object: string, data: StripeObject, customerId?: string) {
  await getDB()
    .insert(schema.stripeMockObject)
    .values({ id, object, customerId: customerId ?? null, data })
    .onConflictDoUpdate({
      target: schema.stripeMockObject.id,
      set: { data, customerId: customerId ?? null, updatedAt: new Date() }
    });

  return data;
}

export async function readObject(id: string): Promise<StripeObject | null> {
  const [row] = await getDB()
    .select({ data: schema.stripeMockObject.data })
    .from(schema.stripeMockObject)
    .where(eq(schema.stripeMockObject.id, id))
    .limit(1);

  return row?.data ?? null;
}

async function listByCustomer(object: string, customerId: string) {
  const rows = await getDB()
    .select({ data: schema.stripeMockObject.data })
    .from(schema.stripeMockObject)
    .where(
      and(
        eq(schema.stripeMockObject.object, object),
        eq(schema.stripeMockObject.customerId, customerId)
      )
    );

  return rows.map((row) => row.data);
}

/* -------------------------------------------------------------------------- */
/* Object construction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The catalogue's Prices, served rather than stored: they are configuration, so
 * a row per price would be a copy of `plans.ts` that could disagree with it.
 * `resolveStripePrice` in the plugin retrieves these to find out whether a plan
 * is metered — `licensed` is the answer that means "quantity is seats".
 */
function priceObject(priceId: string): StripeObject | null {
  const plan = SEAT_PLANS.find((entry) => entry.priceId === priceId);
  if (!plan) return null;

  return {
    id: plan.priceId,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: unixNow(),
    currency: plan.currency,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: `${plan.label} seat`,
    product: `prod_${plan.name}`,
    recurring: {
      interval: plan.interval,
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed"
    },
    type: "recurring",
    unit_amount: plan.unitAmount,
    unit_amount_decimal: String(plan.unitAmount)
  };
}

function customerObject(params: FormObject): StripeObject {
  return {
    id: stripeId("cus"),
    object: "customer",
    created: unixNow(),
    email: formString(params.email) ?? null,
    name: formString(params.name) ?? null,
    description: formString(params.description) ?? null,
    livemode: false,
    metadata: metadataOf(params.metadata)
  };
}

/**
 * A line from the request, either naming a catalogue Price or carrying one
 * inline.
 *
 * Both shapes are real Stripe: seats bill against a Price created in advance,
 * while a top-up is an arbitrary amount that exists only for this order and so
 * travels as `price_data`. A stored Price per top-up denomination would be the
 * alternative, and it would put the fee schedule in two places.
 */
interface CheckoutLine {
  /** The catalogue Price id, or null for an inline one. */
  price: string | null;
  quantity: number;
  inline?: { currency: string; unitAmount: number; name: string };
}

function readLineItems(params: FormObject): CheckoutLine[] {
  return Object.values(formObject(params.line_items))
    .map((entry) => formObject(entry))
    .flatMap((entry): CheckoutLine[] => {
      const quantity = Number(formString(entry.quantity) ?? "1") || 1;
      const price = formString(entry.price);

      if (price) return [{ price, quantity }];

      const data = formObject(entry.price_data);
      const unitAmount = Number(formString(data.unit_amount) ?? "");

      if (!Number.isFinite(unitAmount)) return [];

      return [
        {
          price: null,
          quantity,
          inline: {
            currency: formString(data.currency) ?? "usd",
            unitAmount,
            name: formString(formObject(data.product_data).name) ?? "Charge"
          }
        }
      ];
    });
}

/** The Price object a line resolves to, whether it named one or carried one. */
function linePrice(line: CheckoutLine): StripeObject | null {
  if (line.price) return priceObject(line.price);
  if (!line.inline) return null;

  return {
    // Stripe mints an id for an inline price too, and it is a real Price
    // afterwards. Nothing here retrieves it, but answering with a shape that
    // could not exist is how a mock teaches a caller the wrong thing.
    id: stripeId("price"),
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created: unixNow(),
    currency: line.inline.currency,
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: line.inline.name,
    product: null,
    recurring: null,
    type: "one_time",
    unit_amount: line.inline.unitAmount,
    unit_amount_decimal: String(line.inline.unitAmount)
  };
}

function lineTotal(lines: CheckoutLine[]) {
  return lines.reduce((total, line) => {
    const price = linePrice(line);

    return total + (typeof price?.unit_amount === "number" ? price.unit_amount : 0) * line.quantity;
  }, 0);
}

/**
 * Where the browser is sent to complete this checkout.
 *
 * Two pages, because the two things being bought have nothing in common on
 * screen: one prices seats and creates an organization, the other prices credit
 * and adds to a balance. With a real key neither is reached — Stripe hosts the
 * page — so this is the stand-in choosing which of its own screens to open.
 */
function checkoutPageUrl(mode: string, sessionId: string) {
  const page = mode === "payment" ? "topup" : "checkout";

  return `${env.BETTER_AUTH_URL}/billing/${page}/${sessionId}`;
}

function checkoutSessionObject(params: FormObject): StripeObject {
  const id = stripeId("cs");
  const lines = readLineItems(params);
  const mode = formString(params.mode) ?? "subscription";
  // The lines decide the currency — an inline price carries its own, and this
  // app sells seats in one currency and credit in another.
  const currency =
    (linePrice(lines[0])?.currency as string | undefined) ??
    findSeatPlan(SEAT_PLANS[0].name)?.currency ??
    "usd";

  return {
    id,
    object: "checkout.session",
    amount_subtotal: lineTotal(lines),
    amount_total: lineTotal(lines),
    cancel_url: formString(params.cancel_url) ?? null,
    client_reference_id: formString(params.client_reference_id) ?? null,
    created: unixNow(),
    currency,
    customer: formString(params.customer) ?? null,
    customer_email: formString(params.customer_email) ?? null,
    expires_at: unixNow() + 24 * 60 * 60,
    // Stripe only includes this when expanded. Keeping it inline is the one
    // liberty this backend takes with the wire shape, and it is what lets the
    // checkout page price the order without a second round trip. The plugin
    // never reads it.
    line_items: {
      object: "list",
      has_more: false,
      url: `/v1/checkout/sessions/${id}/line_items`,
      data: lines.map((line) => ({
        id: stripeId("li"),
        object: "item",
        amount_total: ((linePrice(line)?.unit_amount as number | undefined) ?? 0) * line.quantity,
        currency,
        quantity: line.quantity,
        price: linePrice(line)
      }))
    },
    livemode: false,
    metadata: metadataOf(params.metadata),
    mode,
    payment_intent: null,
    payment_status: "unpaid",
    status: "open",
    subscription: null,
    // What `subscription_data.metadata` was, held until there is a subscription
    // to stamp it onto — Stripe does the same thing internally. The same trick
    // for the one-time path, where the metadata belongs to a PaymentIntent that
    // does not exist until the money moves.
    subscription_data: { metadata: metadataOf(formObject(params.subscription_data).metadata) },
    payment_intent_data: {
      metadata: metadataOf(formObject(params.payment_intent_data).metadata)
    },
    success_url: formString(params.success_url) ?? null,
    url: checkoutPageUrl(mode, id)
  };
}

/**
 * The PaymentIntent a completed one-time checkout produces.
 *
 * `amount_received` as well as `amount`, because that is the field a handler
 * should be reading — Stripe sets it to what actually arrived, and the two can
 * differ. Answering with only `amount` would let a caller written against this
 * mock pass a check that a real partial payment would fail.
 */
function paymentIntentObject(session: StripeObject, customerId: string | null): StripeObject {
  const amount = typeof session.amount_total === "number" ? session.amount_total : 0;

  return {
    id: stripeId("pi"),
    object: "payment_intent",
    amount,
    amount_received: amount,
    created: unixNow(),
    currency: session.currency,
    customer: customerId,
    livemode: false,
    metadata: metadataOf(
      formObject((session.payment_intent_data as FormValue | undefined) ?? {}).metadata
    ),
    status: "succeeded"
  };
}

function subscriptionObject(
  session: StripeObject,
  lines: CheckoutLine[],
  customerId: string
): StripeObject {
  const start = unixNow();

  return {
    id: stripeId("sub"),
    object: "subscription",
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    cancellation_details: null,
    created: start,
    currency: session.currency,
    customer: customerId,
    ended_at: null,
    livemode: false,
    metadata: metadataOf(formObject(session.subscription_data as FormValue).metadata),
    schedule: null,
    status: "active",
    trial_start: null,
    trial_end: null,
    items: {
      object: "list",
      has_more: false,
      url: "/v1/subscription_items",
      data: lines.map((line) => {
        const price = linePrice(line);
        const interval =
          ((price?.recurring as { interval?: string } | undefined)?.interval as
            | "month"
            | "year"
            | undefined) ?? "month";

        return {
          id: stripeId("si"),
          object: "subscription_item",
          created: start,
          // On the item rather than the subscription: Stripe moved the billing
          // period down here, and the plugin reads it from exactly this place.
          current_period_start: start,
          current_period_end: periodEnd(start, interval),
          metadata: {},
          price,
          quantity: line.quantity
        };
      })
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Internal operations                                                        */
/* -------------------------------------------------------------------------- */

export interface SettledCheckout {
  session: StripeObject;
  subscription: StripeObject;
}

/**
 * What pressing "Pay" does inside the fake account: mint the subscription the
 * checkout was for and mark the session paid.
 *
 * Not reachable over the fake HTTP surface, because it is not something Stripe
 * exposes over its API either — it is the part a customer does on Stripe's own
 * pages. `server/billing/checkout.ts` is the stand-in for those pages, and this
 * is what it calls.
 *
 * Idempotent: a session that has already been settled returns what it settled
 * to, so a double-submitted form cannot buy two subscriptions.
 */
export async function settleCheckoutSession(sessionId: string): Promise<SettledCheckout | null> {
  const session = await readObject(sessionId);
  if (!session || session.object !== "checkout.session") return null;

  if (session.status === "complete" && typeof session.subscription === "string") {
    const existing = await readObject(session.subscription);

    return existing ? { session, subscription: existing } : null;
  }

  if (session.status !== "open") return null;

  const customerId = typeof session.customer === "string" ? session.customer : null;
  if (!customerId) return null;

  const lines = Object.values(
    formObject((session.line_items as { data?: FormValue } | undefined)?.data)
  ).flatMap((entry) => {
    const line = entry as unknown as { price?: { id?: string }; quantity?: number };
    if (!line.price?.id) return [];

    return [{ price: line.price.id, quantity: line.quantity ?? 1 }];
  });

  const subscription = subscriptionObject(session, lines, customerId);
  await putObject(subscription.id as string, "subscription", subscription, customerId);

  const settled: StripeObject = {
    ...session,
    status: "complete",
    payment_status: "paid",
    subscription: subscription.id
  };
  await putObject(sessionId, "checkout.session", settled, customerId);

  return { session: settled, subscription };
}

export interface SettledPayment {
  session: StripeObject;
  paymentIntent: StripeObject;
}

/**
 * The same for a one-time payment: mint the PaymentIntent and mark the session
 * paid.
 *
 * A separate function rather than a branch inside {@link settleCheckoutSession}
 * because the two produce different objects and their callers want different
 * ones — folding them together would mean every caller unwrapping a union to
 * find out which kind of purchase it had just made.
 *
 * Idempotent on the same terms: a session already settled hands back what it
 * settled to, so a double-pressed button cannot charge twice.
 */
export async function settlePaymentSession(sessionId: string): Promise<SettledPayment | null> {
  const session = await readObject(sessionId);
  if (!session || session.object !== "checkout.session" || session.mode !== "payment") return null;

  if (session.status === "complete" && typeof session.payment_intent === "string") {
    const existing = await readObject(session.payment_intent);

    return existing ? { session, paymentIntent: existing } : null;
  }

  if (session.status !== "open") return null;

  const customerId = typeof session.customer === "string" ? session.customer : null;
  const paymentIntent = paymentIntentObject(session, customerId);

  await putObject(
    paymentIntent.id as string,
    "payment_intent",
    paymentIntent,
    customerId ?? undefined
  );

  const settled: StripeObject = {
    ...session,
    status: "complete",
    payment_status: "paid",
    payment_intent: paymentIntent.id
  };
  await putObject(sessionId, "checkout.session", settled, customerId ?? undefined);

  return { session: settled, paymentIntent };
}

/** Walking away from the checkout, which Stripe records as an expiry. */
export async function expireCheckoutSession(sessionId: string) {
  const session = await readObject(sessionId);
  if (!session || session.object !== "checkout.session" || session.status !== "open") return null;

  const expired: StripeObject = { ...session, status: "expired" };
  await putObject(
    sessionId,
    "checkout.session",
    expired,
    typeof session.customer === "string" ? session.customer : undefined
  );

  return expired;
}

/* -------------------------------------------------------------------------- */
/* HTTP surface                                                               */
/* -------------------------------------------------------------------------- */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": stripeId("req") }
  });
}

/** Stripe's error envelope, which the SDK turns back into a typed error. */
function stripeError(message: string, status = 400, code = "resource_missing") {
  return json({ error: { type: "invalid_request_error", code, message } }, status);
}

function listResponse(data: unknown[], url: string) {
  return json({ object: "list", data, has_more: false, url });
}

/**
 * The fetch handed to `Stripe.createFetchHttpClient`. Every request the SDK
 * makes arrives here fully formed — absolute URL, form body, auth header — and
 * has to leave with something the SDK can parse.
 *
 * Anything this does not implement answers with a Stripe-shaped error rather
 * than an improvised success. A path that has never been exercised returning
 * plausible-looking data is how a mock lies: the caller carries on and fails
 * somewhere unrelated. `501` with the path in the message fails where the gap
 * actually is.
 */
export async function fakeStripeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const method = (init?.method ?? "GET").toUpperCase();
  const params = parseForm(typeof init?.body === "string" ? init.body : "");
  const path = url.pathname.replace(/^\/v1\//, "").split("/");

  // `customers/search` and `customers/{id}` differ only by a reserved word, so
  // the special cases are matched before the id-shaped ones.
  if (path[0] === "customers") {
    if (path[1] === "search") {
      // Answering "no matches" rather than failing keeps the plugin on its
      // fast path: a thrown search sends it into a paginated `customers.list`
      // fallback that would reach the same conclusion more slowly.
      return json({
        object: "search_result",
        data: [],
        has_more: false,
        url: "/v1/customers/search"
      });
    }

    if (!path[1]) {
      if (method === "POST") {
        const customer = customerObject(params);
        await putObject(customer.id as string, "customer", customer);

        return json(customer);
      }

      return listResponse([], "/v1/customers");
    }

    const customer = await readObject(path[1]);
    if (!customer) return stripeError(`No such customer: '${path[1]}'`, 404);

    if (method === "POST") {
      const updated: StripeObject = {
        ...customer,
        ...(formString(params.email) ? { email: formString(params.email) } : {}),
        ...(formString(params.name) ? { name: formString(params.name) } : {})
      };
      await putObject(path[1], "customer", updated);

      return json(updated);
    }

    return json(customer);
  }

  if (path[0] === "prices") {
    // Only ever called with `lookup_keys`, which this catalogue does not use —
    // an empty page sends the plugin to `prices.retrieve` with the id instead.
    if (!path[1]) return listResponse([], "/v1/prices");

    const price = priceObject(path[1]);

    return price ? json(price) : stripeError(`No such price: '${path[1]}'`, 404);
  }

  if (path[0] === "checkout" && path[1] === "sessions") {
    if (!path[2]) {
      if (method !== "POST") return listResponse([], "/v1/checkout/sessions");

      const session = checkoutSessionObject(params);
      await putObject(
        session.id as string,
        "checkout.session",
        session,
        typeof session.customer === "string" ? session.customer : undefined
      );

      return json(session);
    }

    const session = await readObject(path[2]);

    return session ? json(session) : stripeError(`No such checkout session: '${path[2]}'`, 404);
  }

  if (path[0] === "payment_intents") {
    if (!path[1]) return listResponse([], "/v1/payment_intents");

    const intent = await readObject(path[1]);

    return intent ? json(intent) : stripeError(`No such payment_intent: '${path[1]}'`, 404);
  }

  if (path[0] === "subscriptions") {
    if (!path[1]) {
      const customer = url.searchParams.get("customer");

      return listResponse(
        customer ? await listByCustomer("subscription", customer) : [],
        "/v1/subscriptions"
      );
    }

    const subscription = await readObject(path[1]);

    return subscription
      ? json(subscription)
      : stripeError(`No such subscription: '${path[1]}'`, 404);
  }

  return stripeError(
    `${method} /v1/${path.join("/")} is not implemented by the mock Stripe backend. ` +
      `Set STRIPE_SECRET_KEY to run against a real account.`,
    501,
    "not_implemented"
  );
}
