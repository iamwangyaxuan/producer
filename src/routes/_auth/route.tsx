import { createFileRoute, redirect } from "@tanstack/react-router";

import { sessionQueryOptions } from "#/lib/session";

export const Route = createFileRoute("/_auth")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());

    if (!session) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }

    // Exposed to every nested route through `Route.useRouteContext()`.
    return { session };
  }
  // No `component`: this route is a guard, not a layout, and a route without
  // one renders its children — which is all a pass-through could have done.
});
