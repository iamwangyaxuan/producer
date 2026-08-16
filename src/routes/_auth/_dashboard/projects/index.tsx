import { createFileRoute } from "@tanstack/react-router";

import {
  ProjectsPage,
  ProjectsPageError,
  ProjectsPagePending
} from "#/components/block/projects-page";
import { organizationProjectsQueryOptions } from "#/lib/projects";

/**
 * The default list: everything that has not been archived. Its other half is
 * `projects/archive.tsx`, and the two are the same component told which one it
 * is — see `components/block/projects-page.tsx` for what actually differs.
 */
export const Route = createFileRoute("/_auth/_dashboard/projects/")({
  /**
   * `_auth` has already resolved the session, so the active organization is
   * known before the first render. `ensureQueryData` rather than `prefetchQuery`
   * because the server render has to contain the real grid, and a failed read
   * has to reach the router so both sides of hydration agree on showing
   * `errorComponent` — a prefetch swallows the rejection, which is the classic
   * way to render an error on the server and a spinner in the browser.
   *
   * Nothing is returned on purpose: `router.tsx` wires up
   * `setupRouterSsrQueryIntegration`, so the query cache already carries the
   * rows to the client. Returning them would serialize the same list into the
   * document a second time as loader data.
   */
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(
      organizationProjectsQueryOptions(context.session.session.activeOrganizationId, false)
    );
  },
  pendingComponent: () => <ProjectsPagePending archived={false} />,
  errorComponent: (props) => <ProjectsPageError {...props} archived={false} />,
  component: RouteComponent
});

function RouteComponent() {
  const { session } = Route.useRouteContext();

  return (
    <ProjectsPage archived={false} activeOrganizationId={session.session.activeOrganizationId} />
  );
}
