import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { getDB, newRowId, schema } from "#/db";
import { auth } from "#/lib/auth";
import { authClient } from "#/lib/auth-client";
import { CREATABLE_TYPES } from "#/lib/organization";
import { clampSeats, findSeatPlan } from "#/lib/plans";
import {
  abandonCheckoutOrder,
  CheckoutError,
  payCheckoutOrder,
  readCheckoutOrder
} from "#/server/billing/checkout";
import type { CheckoutOrder } from "#/server/billing/checkout";

export type { CheckoutOrder };

/** Same ceiling as a project's name: long enough for a sentence, short enough to show. */
export const ORGANIZATION_NAME_MAX_LENGTH = 120;

/**
 * Where the browser goes when a checkout ends, either way. Both are relative,
 * which is what lets better-auth's origin check pass them without this file
 * knowing what host it is running on.
 */
const AFTER_CHECKOUT_URL = "/projects";

/** Resolved from the session cookie, like every other write in this app. */
async function requireUser() {
  const session = await auth.api.getSession({ headers: getRequest().headers });

  if (!session) throw new Error("Not signed in.");

  return session.user;
}

const draftInput = z.object({
  name: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX_LENGTH),
  type: z.enum(CREATABLE_TYPES),
  seats: z.number().int().positive()
});

export interface OrganizationDraft {
  /** Also the id the organization will be created with, once it is paid for. */
  id: string;
  type: (typeof CREATABLE_TYPES)[number];
  seats: number;
}

/**
 * Reserves the organization before anyone pays for it.
 *
 * The id is minted here rather than after the payment because it is what the
 * subscription is bought *against*: `referenceId` has to name the tenant from
 * the first call, and rewriting it afterwards would leave a window where a paid
 * subscription pointed at nothing. `newRowId` mints it with the same `uuidv7()`
 * the column default would have used, so the organization that eventually lands
 * is ordered among its peers like any other row.
 *
 * Nothing here charges anything, and the draft grants nothing on its own — it
 * only makes `authorizeReference` willing to accept the id from this user. The
 * seat count is clamped to what the plan is sold in rather than rejected: the
 * dialog already constrains the control, so an out-of-range number is a stale
 * client or a hand-made request, and neither deserves an error page.
 */
export const createOrganizationDraft = createServerFn({ method: "POST" })
  .validator(draftInput)
  .handler(async ({ data }): Promise<OrganizationDraft> => {
    const user = await requireUser();

    const plan = findSeatPlan(data.type);
    if (!plan) throw new Error("That plan is not for sale.");

    const seats = clampSeats(plan, data.seats);
    const db = getDB();
    const id = await newRowId(db);

    await db.insert(schema.organizationDraft).values({
      id,
      userId: user.id,
      name: data.name,
      type: data.type,
      seats
    });

    return { id, type: data.type, seats };
  });

const sessionInput = z.object({ sessionId: z.string().max(128) });

/**
 * What the checkout page shows. `null` covers a made-up id, a checkout started
 * by somebody else, and one whose session has been swept — all of which should
 * look the same, and none of which is an error worth a stack trace.
 */
export const fetchCheckoutOrder = createServerFn({ method: "GET" })
  .validator(sessionInput)
  .handler(async ({ data }): Promise<CheckoutOrder | null> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });
    if (!session) return null;

    return await readCheckoutOrder(data.sessionId, session.user.id);
  });

export function checkoutOrderQueryOptions(sessionId: string) {
  return queryOptions({
    queryKey: ["billing", "checkout", sessionId],
    queryFn: ({ signal }) => fetchCheckoutOrder({ data: { sessionId }, signal }),
    // Same reason as everywhere else: the route loader resolves this during
    // SSR, and at 0 the hydrated entry refetches the moment it mounts.
    staleTime: 30_000
  });
}

/**
 * Everything this endpoint can fail with, phrased for the person who will read
 * it.
 *
 * The dialogs elsewhere in this app hide `error.message` outside development,
 * because a failed server function can carry a connection string or a fragment
 * of SQL. The checkout cannot afford that: "the payment went through but the
 * organization was not created" is the one message someone genuinely needs, and
 * a generic "something went wrong" would be a lie about their money.
 *
 * So the leak is closed at the source instead of at the screen — anything that
 * is not already a `CheckoutError` is logged here and replaced, which makes
 * every message that reaches the client one that was written to be shown.
 */
async function withCheckoutMessages<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CheckoutError) throw error;

    console.error("checkout failed", error);

    throw new CheckoutError("Something went wrong with this checkout. Please try again.");
  }
}

/**
 * The two ends of the checkout. Both re-derive the user from the cookie and let
 * the helper decide whether this session is theirs, so neither trusts the id it
 * was handed for anything but a lookup.
 */
export const payCheckout = createServerFn({ method: "POST" })
  .validator(sessionInput)
  .handler(async ({ data }): Promise<CheckoutOrder> => {
    const user = await requireUser();

    return await withCheckoutMessages(() => payCheckoutOrder(data.sessionId, user.id));
  });

export const abandonCheckout = createServerFn({ method: "POST" })
  .validator(sessionInput)
  .handler(async ({ data }): Promise<CheckoutOrder> => {
    const user = await requireUser();

    return await withCheckoutMessages(() => abandonCheckoutOrder(data.sessionId, user.id));
  });

/**
 * Starting a purchase: reserve the id, then ask the Stripe plugin for a
 * checkout to send the browser to.
 *
 * Two round trips, and deliberately so. The upgrade goes through
 * `authClient.subscription.upgrade` from the browser rather than
 * `auth.api.upgradeSubscription` from a server function, because the endpoint
 * runs an origin check over the success and cancel URLs — a real request with a
 * real `Origin` header satisfies it, while a server-to-server call has none to
 * offer. It also means the client sees the plugin's own error codes (no seats,
 * already subscribed, unauthorized reference) instead of a rethrown string.
 *
 * `disableRedirect` because the caller decides when to leave: the mutation
 * hands back a URL, and the dialog navigates once it has closed.
 */
export function useCreateOrganization() {
  return useMutation({
    mutationFn: async (variables: {
      name: string;
      type: (typeof CREATABLE_TYPES)[number];
      seats: number;
    }) => {
      const draft = await createOrganizationDraft({ data: variables });

      const { data, error } = await authClient.subscription.upgrade({
        plan: draft.type,
        referenceId: draft.id,
        seats: draft.seats,
        successUrl: AFTER_CHECKOUT_URL,
        cancelUrl: AFTER_CHECKOUT_URL,
        disableRedirect: true
      });

      if (error) throw new Error(error.message ?? "Could not start the checkout.");
      if (!data?.url) throw new Error("Could not start the checkout.");

      return { url: data.url, organizationId: draft.id };
    }
  });
}

/**
 * Paying. On success the new organization is made the active one *before* the
 * browser follows Stripe's success URL: the redirect ends on the projects page,
 * and that page reads whatever the session is scoped to — so switching after
 * the navigation would show the previous organization's grid first and then
 * replace it.
 *
 * The switch is a separate failure from the payment and is treated as one. The
 * organization exists and is paid for either way; landing in the old scope is a
 * cosmetic loss the switcher in the sidebar fixes, and turning it into an error
 * would tell someone their purchase failed when it did not.
 */
export function usePayCheckout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { sessionId: string }) => {
      const order = await payCheckout({ data: variables });

      if (order.organizationId) {
        await authClient.organization
          .setActive({ organizationId: order.organizationId })
          .catch(() => undefined);
      }

      return order;
    },
    onSuccess: async () => {
      // The sidebar's list and every organization-scoped read, which the new
      // organization has just changed the answer to.
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    }
  });
}

export function useAbandonCheckout() {
  return useMutation({
    mutationFn: (variables: { sessionId: string }) => abandonCheckout({ data: variables })
  });
}
