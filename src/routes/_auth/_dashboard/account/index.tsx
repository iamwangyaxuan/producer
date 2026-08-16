import { createFileRoute } from "@tanstack/react-router";

import { ProfilePage, ProfilePageError, ProfilePagePending } from "#/components/block/profile-page";
import { profileQueryOptions } from "#/lib/profile";

/**
 * The account page.
 *
 * The one route under `_dashboard` that is *not* organization-scoped, which is
 * also why its loader takes nothing from the route context: the answer is the
 * same whichever workspace the switcher is pointing at, so there is no id to
 * key it by and nothing to re-resolve when somebody switches.
 */
export const Route = createFileRoute("/_auth/_dashboard/account/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(profileQueryOptions());
  },
  pendingComponent: ProfilePagePending,
  errorComponent: ProfilePageError,
  component: ProfilePage
});
