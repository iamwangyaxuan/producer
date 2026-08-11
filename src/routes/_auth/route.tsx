import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { sessionQueryOptions } from "#/lib/session";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());

    if (!session) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }

    // Exposed to every nested route through `Route.useRouteContext()`.
    return { session };
  },
  component: RouteComponent
});

function RouteComponent() {
  return <Outlet />;
}
