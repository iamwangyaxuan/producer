import { createFileRoute, Outlet } from "@tanstack/react-router";

import AccountMenu from "#/components/block/account-menu";
import DashboardNav from "#/components/block/dashboard-nav";
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

  /*
   * The shell is exactly one viewport tall and never scrolls; the content
   * column scrolls inside it.
   *
   * With a page-height shell the document is the scroller, which means a long
   * project grid drags the sidebar up out of view with it — the switcher, the
   * navigation and the account menu all leave the screen precisely when
   * somebody has scrolled far enough to want them. Pinning the frame and
   * moving the overflow inward keeps every fixed part of the app fixed.
   *
   * `h-dvh` rather than `h-screen`: on mobile browsers `100vh` is the height
   * the viewport has when the address bar is hidden, so a `h-screen` shell is
   * taller than the visible area for as long as that bar is showing, and the
   * bottom of the sidebar sits under it.
   */
  return (
    <main className="flex h-dvh overflow-hidden">
      {/*
       * The account menu is pushed down by `mt-auto` rather than laid out from
       * the top, so it stays at the foot of the sidebar however far the
       * navigation above it grows.
       *
       * A strip on narrow screens instead of a drawer that has to be opened —
       * every control in here collapses to an icon that is still one tap away,
       * and hiding them behind a hamburger would put them further away on a
       * phone than on a desktop.
       *
       * Its own scroller too, for the short window where the navigation is
       * taller than the screen: `mt-auto` still parks the account menu at the
       * foot whenever there is room, and only gives that up when there is not.
       */}
      <aside className="flex w-14 shrink-0 flex-col overflow-y-auto border-r border-neutral-800 p-2 md:w-60 md:p-3">
        {/* Which organization the pages to the right are scoped to — and the
            way to point them somewhere else. The head of the sidebar, so the
            scope reads before the content it scopes, and before the navigation
            whose destinations are all inside it. */}
        <OrganizationSwitcher />
        <DashboardNav />
        <div className="mt-auto">
          <AccountMenu user={session.user} />
        </div>
      </aside>
      {/*
       * `min-w-0` so the grid inside can shrink; a flex child sizes to its
       * content otherwise and would push the page into a horizontal scroll.
       *
       * `data-scroll-restoration-id` is what keeps the back button honest now
       * that this — and not the window — is what moves. The router restores the
       * window's offset for free; a custom scroller has to name itself, or
       * every return to a scrolled list lands at the top of it.
       */}
      <div
        data-scroll-restoration-id="dashboard-content"
        className="min-w-0 flex-1 overflow-y-auto"
      >
        <Outlet />
      </div>
    </main>
  );
}
