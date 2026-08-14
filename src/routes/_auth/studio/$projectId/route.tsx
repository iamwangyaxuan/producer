import { createFileRoute, notFound } from "@tanstack/react-router";

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

    // Missing, archived, or another organization's — the server does not
    // distinguish those, and neither should this page.
    if (!project) throw notFound();

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
