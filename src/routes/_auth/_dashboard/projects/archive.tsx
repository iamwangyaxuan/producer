import { createFileRoute } from "@tanstack/react-router";

import {
  ProjectsPage,
  ProjectsPageError,
  ProjectsPagePending
} from "#/components/block/projects-page";
import { organizationProjectsQueryOptions } from "#/lib/projects";

/**
 * The archive: the same list with `archived` flipped.
 *
 * It is a route of its own rather than a search parameter on the list because
 * it is somewhere you go — the sidebar links to it, the browser can go back to
 * it, and it can be bookmarked or shared. A `?archived=1` would give the two
 * views one address between them.
 */
export const Route = createFileRoute("/_auth/_dashboard/projects/archive")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(
      organizationProjectsQueryOptions(context.session.session.activeOrganizationId, true)
    );
  },
  pendingComponent: () => <ProjectsPagePending archived={true} />,
  errorComponent: (props) => <ProjectsPageError {...props} archived={true} />,
  component: RouteComponent
});

function RouteComponent() {
  const { session } = Route.useRouteContext();

  return (
    <ProjectsPage archived={true} activeOrganizationId={session.session.activeOrganizationId} />
  );
}
