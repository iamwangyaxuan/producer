import type { CreatableOrganizationType } from "#/lib/organization";

/**
 * What an organization costs, and how many people it may hold.
 *
 * One catalogue read from both sides, for the reason `models.ts` is one: the
 * checkout page prices a slider from it while `auth.ts` hands the same entries
 * to the Stripe plugin as its `plans`. Two copies would let the number someone
 * agreed to pay drift from the number that was charged.
 *
 * A plan's `name` is also the organization `type` it creates. That is not a
 * coincidence worth undoing — the plugin identifies plans by name, this app
 * identifies organizations by type, and collapsing them means a subscription
 * row already says what kind of organization it bought.
 */
export interface SeatPlan {
  name: CreatableOrganizationType;
  label: string;
  /** One line under the name in the create dialog. */
  description: string;
  /**
   * The Stripe Price this bills against.
   *
   * Deliberately readable rather than a real `price_1Q…` id: nothing has been
   * created in a Stripe account yet, and an id that *looks* real is the kind of
   * placeholder that survives to production. Replacing these two strings with
   * ids from a live account is the whole of "connect billing for real" on the
   * catalogue side.
   */
  priceId: string;
  /**
   * Cents per seat per billing period. Cents, not dollars, because that is the
   * unit Stripe quotes and stores — converting once here rather than at every
   * call site is what keeps a rounding error out of an invoice.
   */
  unitAmount: number;
  currency: string;
  /** Billing period, in Stripe's vocabulary. */
  interval: "month" | "year";
  /**
   * The seat range this plan is sold in. `min` is a product statement rather
   * than a technical floor — a two-person minimum is what makes a team a team,
   * and an organization that only ever holds its owner is the private workspace
   * everyone already has for free.
   */
  minSeats: number;
  maxSeats: number;
  defaultSeats: number;
}

export const SEAT_PLANS = [
  {
    name: "team",
    label: "Team",
    description: "A shared workspace for a group that is all working on the same things.",
    priceId: "price_team_monthly_seat",
    unitAmount: 1200,
    currency: "usd",
    interval: "month",
    minSeats: 2,
    maxSeats: 50,
    defaultSeats: 5
  },
  {
    name: "enterprise",
    label: "Enterprise",
    description: "Single sign-on and directory provisioning, for a company-wide rollout.",
    priceId: "price_enterprise_monthly_seat",
    unitAmount: 2900,
    currency: "usd",
    interval: "month",
    minSeats: 10,
    maxSeats: 500,
    defaultSeats: 25
  }
] as const satisfies readonly SeatPlan[];

/**
 * The catalogue entry for an organization type, or `undefined` for `private` —
 * which is not sold, so it has no entry rather than a free one.
 */
export function findSeatPlan(name: string): SeatPlan | undefined {
  return SEAT_PLANS.find((plan) => plan.name === name);
}

/** Clamps a requested seat count into what the plan is actually sold in. */
export function clampSeats(plan: SeatPlan, seats: number) {
  if (!Number.isFinite(seats)) return plan.defaultSeats;

  return Math.min(plan.maxSeats, Math.max(plan.minSeats, Math.round(seats)));
}

/** Cents, the same unit Stripe would total the line item in. */
export function seatTotal(plan: SeatPlan, seats: number) {
  return plan.unitAmount * seats;
}

/**
 * Whole dollars are written without the `.00` — a price list where every row
 * ends in two zeros is two characters of noise per row, and none of the amounts
 * this catalogue can produce have cents in them.
 */
export function formatAmount(cents: number, currency: string) {
  const hasFraction = cents % 100 !== 0;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2
  }).format(cents / 100);
}
