import { createFileRoute, Outlet } from "@tanstack/react-router";

import AccountMenu from "#/components/block/account-menu";
import OrganizationSwitcher from "#/components/block/organization-switcher";
import { myOrganizationsQueryOptions } from "#/lib/organizations";

export const Route = createFileRoute("/_auth/_dashboard")({
  /**
   * The switcher's list, resolved before anything renders for the reason the
   * projects page resolves its grid: the server render should carry the real
   * sidebar, not a placeholder that pops in after hydration.
   */
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(myOrganizationsQueryOptions());
  },
  component: RouteComponent
});

function RouteComponent() {
  // Resolved by the `_auth` guard before anything under it renders, so there is
  // no loading state here and no second read of the session.
  const { session } = Route.useRouteContext();

  return (
    <main className="flex min-h-screen">
      {/*
       * Navigation will land in the empty space above the account menu, which is
       * why the menu is pushed down by `mt-auto` rather than being laid out from
       * the top: it stays at the foot of the sidebar as that list grows.
       *
       * A strip on narrow screens instead of a drawer that has to be opened —
       * there is one control in here, and hiding it behind a hamburger would put
       * signing out further away on a phone than on a desktop.
       */}
      <aside className="flex w-14 shrink-0 flex-col border-r border-neutral-800 p-2 md:w-60 md:p-3">
        {/* Which organization the pages to the right are scoped to — and the
            way to point them somewhere else. The head of the sidebar, so the
            scope reads before the content it scopes. */}
        <OrganizationSwitcher />
        <div className="mt-auto">
          <AccountMenu user={session.user} />
        </div>
      </aside>
      {/* `min-w-0` so the grid inside can shrink; a flex child sizes to its
          content otherwise and would push the page into a horizontal scroll. */}
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </main>
  );
}
