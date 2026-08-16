/**
 * The unit every amount in this app is counted in, and the two conversions that
 * are allowed to leave it.
 *
 * Its own module because both ends of the pricing graph need it and neither may
 * import the other: `models.ts` writes prices with `usd()`, `pricing.ts` reads
 * the catalogue to total them up, and a shared constant living in either one
 * would close that loop.
 *
 * The currency is USD, the same one the seat plans in `plans.ts` are sold in —
 * and, not incidentally, the one the AI Gateway bills us in. That last part is
 * what makes `usage_event` legible: what a call was sold for and what it cost
 * are two columns in one currency, so the margin is a subtraction rather than
 * an exchange rate this app has no business inventing.
 */

/** Micro-dollars per dollar. One micro-dollar is 1e-6 USD — see `credit_account`. */
export const MICRO_PER_DOLLAR = 1_000_000;

/** Cents per dollar. Cents are the minor unit Stripe quotes USD in. */
export const CENTS_PER_DOLLAR = 100;

const MICRO_PER_CENT = MICRO_PER_DOLLAR / CENTS_PER_DOLLAR;

/**
 * A price written the way a person would say it, stored the way the wallet
 * counts it. Rounded rather than trusted: `0.07 * 1e6` is not an integer in
 * IEEE 754, and a price that is a fraction of a micro-dollar is not a price.
 */
export function usd(amount: number) {
  return Math.round(amount * MICRO_PER_DOLLAR);
}

/**
 * Micro-dollars to the cents Stripe charges in, rounded **up**.
 *
 * Up, because this converts what we are owed into what we ask for, and rounding
 * that one down means giving away a cent on every order that has a fraction in
 * it. The direction matters here and nowhere else, which is why there is one
 * function for it rather than a `Math.round` at each call site.
 */
export function microToCents(micro: number) {
  return Math.ceil(micro / MICRO_PER_CENT);
}

export function centsToMicro(cents: number) {
  return cents * MICRO_PER_CENT;
}

/**
 * An amount as money, for a person to read.
 *
 * Between two and four decimals, and the upper bound is the point. A generation
 * costs a fraction of a cent more than its model's price — the flat naming fee —
 * so a two-decimal formatter would print $0.091 as "$0.09" beside the send
 * button and then take $0.091. Rounding *down* there is the dangerous direction
 * to be wrong in, and either way it is a number on screen that is not the number
 * being charged, on the one screen where those must agree. Amounts with nothing
 * below a cent are unaffected: $100 still reads "$100.00".
 */
export function formatUsd(micro: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  }).format(micro / MICRO_PER_DOLLAR);
}

/** The same, from Stripe's cents — for the screens that quote a charge. */
export function formatCents(cents: number) {
  return formatUsd(centsToMicro(cents));
}
