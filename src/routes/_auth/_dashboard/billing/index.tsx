import { createFileRoute } from "@tanstack/react-router";

import { BillingPage, BillingPageError, BillingPagePending } from "#/components/block/billing-page";
import { statementQueryOptions, usageSummaryQueryOptions, walletQueryOptions } from "#/lib/credits";
import { gatewayKeyQueryOptions } from "#/lib/gateway-key";

/**
 * The wallet page.
 *
 * Scoped to the organization the sidebar above it is pointing at, like every
 * other page under `_dashboard`: the wallet belongs to the tenant, so switching
 * organizations switches the balance, the statement and the usage report
 * together. What does *not* switch is who is paying — a top-up is charged to
 * the person's own card, whichever organization it credits.
 *
 * `?topup=paid` is what a completed payment redirects back to. It is validated
 * rather than read raw because it is a URL anyone can type, and the only thing
 * it may do is switch on one line of reassurance.
 */
export const Route = createFileRoute("/_auth/_dashboard/billing/")({
  // The key is dropped rather than set to `undefined` when it is not "paid":
  // an optional property is what lets every other link to this page — the
  // sidebar's, the outcome screen's — omit `search` entirely.
  validateSearch: (search: Record<string, unknown>): { topup?: "paid" } =>
    search.topup === "paid" ? { topup: "paid" } : {},
  loader: async ({ context }) => {
    const organizationId = context.session.session.activeOrganizationId;

    // All three in parallel: the page suspends on every one of them, so
    // resolving them in series would make the first paint wait for the sum.
    // The two managed reads are prefetched even for a member who may not see
    // them — they answer with a refusal the boundary never mounts, and paying
    // for that on a loader is cheaper than a waterfall for everyone else.
    await Promise.all([
      context.queryClient.ensureQueryData(walletQueryOptions(organizationId)),
      context.queryClient
        .ensureQueryData(statementQueryOptions(organizationId))
        .catch(() => undefined),
      context.queryClient
        .ensureQueryData(usageSummaryQueryOptions(organizationId))
        .catch(() => undefined),
      context.queryClient
        .ensureQueryData(gatewayKeyQueryOptions(organizationId))
        .catch(() => undefined)
    ]);
  },
  pendingComponent: BillingPagePending,
  errorComponent: BillingPageError,
  component: RouteComponent
});

function RouteComponent() {
  const { topup } = Route.useSearch();
  const { session } = Route.useRouteContext();

  return (
    <BillingPage
      justPaid={topup === "paid"}
      activeOrganizationId={session.session.activeOrganizationId}
    />
  );
}
