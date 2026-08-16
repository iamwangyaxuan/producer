import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import type { CreditTransactionKind } from "#/db/schema";
import { auth } from "#/lib/auth";
import {
  BILLING_ROLES,
  BillingAccessError,
  readBillingViewer,
  requireBillingAccess
} from "#/lib/billing-access";
import { isSellableTopup, MAX_TOPUP, MIN_TOPUP } from "#/lib/pricing";
import { listTransactions, readBalance, summarizeUsage } from "#/server/billing/credits";
import type { UsageSummaryRow } from "#/server/billing/credits";
import {
  abandonTopupOrder,
  payTopupOrder,
  readTopupOrder,
  startTopup,
  TopupError
} from "#/server/billing/topup";
import type { TopupOrder } from "#/server/billing/topup";
import { hasSystemGatewayKey } from "#/server/generation/gateway";
import { readGatewayKeyStatus } from "#/server/generation/gateway-key";

export type { TopupOrder, UsageSummaryRow };

/**
 * The wallet, as the browser sees it.
 *
 * The same shape as `lib/billing.ts` next door — server functions, query
 * options, mutation hooks — because they are the same kind of thing: money,
 * scoped to the organization the *session* is pointed at and never to an id in
 * a request body.
 *
 * Who may do what is decided in `lib/billing-access.ts`, which the Gateway key
 * settings share: the balance is any member's to read, while topping up and
 * reading the statement belong to the roles that already control the seat
 * subscription. A statement is also a roster by another name — it says who
 * spent what.
 */

/** How much statement to load. One screen of it; there is no pagination yet. */
const STATEMENT_LIMIT = 50;

/** The window the usage report covers. */
const USAGE_DAYS = 30;

export interface WalletSummary {
  organizationId: string;
  organizationName: string;
  balance: number;
  lifetimeToppedUp: number;
  lifetimeSpent: number;
  /**
   * Whether this viewer may top up and read the statement. It travels with the
   * balance because the page has to decide what to render, and a second round
   * trip to ask "may I" would answer a question this read already knows.
   */
  canManage: boolean;
  /**
   * Whether generations in this organization are charged to this balance.
   *
   * The one input to `quoteGeneration` the browser cannot work out for itself,
   * so it travels here rather than being guessed. It is false in two different
   * situations and the composer treats them the same — quote nothing — while
   * the page explains them differently:
   *
   * - the organization runs on **its own** Gateway key, so Vercel has already
   *   billed it and charging the wallet too would be charging twice;
   * - there is **no** key at all, so every generation returns a stand-in file,
   *   which is not something to charge for either.
   */
  billingEnabled: boolean;
  /** True when the organization supplied its own key. Distinguishes the two. */
  usesOwnKey: boolean;
  /** Whether generations run for real at all, on either key. */
  gatewayAvailable: boolean;
}

const NO_WALLET: WalletSummary = {
  organizationId: "",
  organizationName: "",
  balance: 0,
  lifetimeToppedUp: 0,
  lifetimeSpent: 0,
  canManage: false,
  billingEnabled: false,
  usesOwnKey: false,
  gatewayAvailable: false
};

/**
 * The active organization's balance, readable by any of its members.
 *
 * Any member, because this is what the composer prices a generation against and
 * what refuses one it cannot pay for — a member who is about to be told "not
 * enough credits" is owed the number behind that sentence.
 *
 * Answers zero for an organization with no wallet row rather than creating one:
 * a page view should not be a write, and "nothing yet" is the truth.
 */
export const fetchWallet = createServerFn({ method: "GET" }).handler(
  async (): Promise<WalletSummary> => {
    const viewer = await readBillingViewer();

    if (!viewer) return NO_WALLET;

    // Existence, not the key itself: this read happens on every canvas load and
    // every billing page view, and none of them needs the plaintext.
    const own = await readGatewayKeyStatus(viewer.organizationId);
    const usesOwnKey = own !== null;

    return {
      ...(await readBalance(viewer.organizationId)),
      organizationId: viewer.organizationId,
      organizationName: viewer.organizationName,
      canManage: BILLING_ROLES.has(viewer.role),
      // The same precedence `resolveGateway` applies, from the same two facts —
      // their key first, ours second — so the price the composer shows is the
      // one the server will charge.
      billingEnabled: !usesOwnKey && hasSystemGatewayKey(),
      usesOwnKey,
      gatewayAvailable: usesOwnKey || hasSystemGatewayKey()
    };
  }
);

/**
 * Keyed by organization, like every organization-scoped read here. The id only
 * ever enters the key — the server decides what to read from the session — and
 * its one job is to stop a switch of organization from painting the previous
 * tenant's balance.
 */
export function walletQueryOptions(organizationId: string | null | undefined) {
  return queryOptions({
    queryKey: ["credits", organizationId ?? "none", "wallet"],
    queryFn: ({ signal }) => fetchWallet({ signal }),
    // Same 30s as everything else. The balance moves under this query whenever
    // a generation runs, and `useGenerations` invalidates the whole `credits`
    // prefix when one finishes — so staleness here is only about other tabs.
    staleTime: 30_000
  });
}

export interface StatementLine {
  id: string;
  kind: CreditTransactionKind;
  amount: number;
  balanceAfter: number;
  description: string | null;
  /** Who moved it — null once that account is gone. */
  actor: string | null;
  /** ISO, because a `Date` does not survive the trip as one. */
  createdAt: string;
}

export const fetchStatement = createServerFn({ method: "GET" }).handler(
  async (): Promise<StatementLine[]> => {
    const viewer = await requireBillingAccess();
    const rows = await listTransactions(viewer.organizationId, STATEMENT_LIMIT);

    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }
);

export function statementQueryOptions(organizationId: string | null | undefined) {
  return queryOptions({
    queryKey: ["credits", organizationId ?? "none", "statement"],
    queryFn: ({ signal }) => fetchStatement({ signal }),
    staleTime: 30_000
  });
}

export const fetchUsageSummary = createServerFn({ method: "GET" }).handler(
  async (): Promise<UsageSummaryRow[]> => {
    const viewer = await requireBillingAccess();

    return await summarizeUsage(viewer.organizationId, USAGE_DAYS);
  }
);

export function usageSummaryQueryOptions(organizationId: string | null | undefined) {
  return queryOptions({
    queryKey: ["credits", organizationId ?? "none", "usage"],
    queryFn: ({ signal }) => fetchUsageSummary({ signal }),
    staleTime: 30_000
  });
}

/* -------------------------------------------------------------------------- */
/* Topping up                                                                 */
/* -------------------------------------------------------------------------- */

const topupInput = z.object({
  /** Micro-dollars to credit. The charge is derived, never sent. */
  credit: z.number().int().min(MIN_TOPUP).max(MAX_TOPUP)
});

/**
 * What reaches the client from a top-up, phrased for the person reading it.
 *
 * Same rule as the seat checkout, and for the same reason: "the payment went
 * through but the credit was not added" is a sentence somebody genuinely needs,
 * so it cannot be flattened into "something went wrong". Everything that is not
 * already a `TopupError` is logged and replaced here, which makes every message
 * that leaves this module one that was written to be read.
 */
async function withTopupMessages<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    // `BillingAccessError` passes through with `TopupError`: "you cannot manage
    // billing for this organization" was written to be read, and replacing it
    // with the generic line would turn a clear refusal into a mystery.
    if (error instanceof TopupError || error instanceof BillingAccessError) throw error;

    console.error("top-up failed", error);

    throw new TopupError("Something went wrong with this top-up. Please try again.");
  }
}

/**
 * Buys credit for the active organization, on the caller's own card.
 *
 * Both halves of that sentence are resolved here and neither is accepted from
 * the request: the organization comes from the session, the payer is the
 * session's user, and the only thing the client gets to choose is how much.
 */
export const createTopup = createServerFn({ method: "POST" })
  .validator(topupInput)
  .handler(async ({ data }): Promise<{ url: string }> => {
    return await withTopupMessages(async () => {
      const viewer = await requireBillingAccess();
      const session = await auth.api.getSession({ headers: getRequest().headers });

      if (!session) throw new TopupError("You cannot manage billing for this organization.");

      // Checked again beyond the validator: the bounds are a product rule that
      // lives in `pricing.ts`, and a zod range is a copy of it that can fall
      // behind.
      if (!isSellableTopup(data.credit)) throw new TopupError("That is not an amount we can add.");

      const { url } = await startTopup(
        viewer.organizationId,
        { id: session.user.id, email: session.user.email, name: session.user.name },
        data.credit
      );

      return { url };
    });
  });

const sessionInput = z.object({ sessionId: z.string().max(128) });

export const fetchTopupOrder = createServerFn({ method: "GET" })
  .validator(sessionInput)
  .handler(async ({ data }): Promise<TopupOrder | null> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });
    if (!session) return null;

    return await readTopupOrder(data.sessionId, session.user.id);
  });

export function topupOrderQueryOptions(sessionId: string) {
  return queryOptions({
    // Not organization-keyed, unlike the reads above: a checkout belongs to the
    // person paying and is addressed by a session id that is unique on its own.
    queryKey: ["credits", "topup", sessionId],
    queryFn: ({ signal }) => fetchTopupOrder({ data: { sessionId }, signal }),
    staleTime: 30_000
  });
}

export const payTopup = createServerFn({ method: "POST" })
  .validator(sessionInput)
  .handler(async ({ data }): Promise<TopupOrder> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });

    if (!session) throw new TopupError("That top-up no longer exists.");

    return await withTopupMessages(() => payTopupOrder(data.sessionId, session.user.id));
  });

export const abandonTopup = createServerFn({ method: "POST" })
  .validator(sessionInput)
  .handler(async ({ data }): Promise<TopupOrder> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });

    if (!session) throw new TopupError("That top-up no longer exists.");

    return await withTopupMessages(() => abandonTopupOrder(data.sessionId, session.user.id));
  });

/**
 * Starting a top-up. The mutation hands back a URL and the caller navigates,
 * for the same reason the organization dialog does: with a real key that URL is
 * `checkout.stripe.com` and leaving is not a route change.
 */
export function useStartTopup() {
  return useMutation({
    mutationFn: async (variables: { credit: number }) => await createTopup({ data: variables })
  });
}

export function usePayTopup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { sessionId: string }) => payTopup({ data: variables }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["credits"] });
    }
  });
}

export function useAbandonTopup() {
  return useMutation({
    mutationFn: (variables: { sessionId: string }) => abandonTopup({ data: variables })
  });
}
