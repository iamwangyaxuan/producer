import { createFileRoute, notFound } from "@tanstack/react-router";

import { canvasSnapshotQueryOptions } from "#/lib/canvas-snapshot";
import { projectQueryOptions } from "#/lib/projects";

export const Route = createFileRoute("/_auth/studio/$projectId")({
  /**
   * The layout route owns the read because the document title belongs to every
   * screen nested under it. `ensureQueryData` leaves the project in the cache
   * the children will read from, while the loader itself returns only the name:
   * that is what `head` is handed, and it is the one field the document needs
   * before anything renders.
   */
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData(
      projectQueryOptions(context.session.session.activeOrganizationId, params.projectId)
    );

    // Missing or another organization's — the server does not distinguish those,
    // and neither should this page. Archived is no longer among them: it opens,
    // read-only.
    if (!project) throw notFound();

    // The archived canvas is built from the saved snapshot rather than from a
    // socket, so it is data this loader has to resolve — same contract as the
    // project above, and the reason is the same one every page here follows:
    // a `useSuspenseQuery` whose key the loader never touched has nothing in
    // the cache to read on the first render. Only for archived projects,
    // because a live canvas gets its document from the room and would be
    // paying for a decode it throws away.
    if (project.archived) {
      await context.queryClient.ensureQueryData(canvasSnapshotQueryOptions(params.projectId));
    }

    return { name: project.name };
  },

  /**
   * The deepest match's title wins, so this replaces the shell's "Producer".
   * `loaderData` is absent while the match is still pending, and `name` is NOT
   * NULL without being stopped from holding whitespace; contributing no title at
   * all in either case leaves "Producer" standing, which is a better document
   * title than an empty one.
   */
  head: ({ loaderData }) => {
    const name = loaderData?.name.trim();

    return name ? { meta: [{ title: name }] } : {};
  }
  // No `component`: this layer exists for the loader and the title, and a
  // route without one already renders its children.
});
