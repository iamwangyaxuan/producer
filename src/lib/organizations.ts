import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq } from "drizzle-orm";

import { getDB, schema } from "#/db";
import type { OrganizationType } from "#/db/schema";
import { auth } from "#/lib/auth";
import { authClient } from "#/lib/auth-client";

/** One organization the signed-in user belongs to, as the switcher shows it. */
export interface OrganizationMembership {
  id: string;
  name: string;
  /**
   * Together these decide whether the sidebar offers the members page: there is
   * nobody to manage in a `private` workspace, and managing the other two is
   * the owner's job. Both come from this read rather than a second one because
   * the switcher already joins `member` to `organization` — the two columns are
   * on rows it is holding anyway.
   */
  type: OrganizationType;
  /** This user's role in it, straight off the membership row. */
  role: string;
  /** Whether the current session is scoped to it. */
  active: boolean;
}

/**
 * Whether this membership should show a members page. Exported because the
 * sidebar asks it to decide on a link and the page itself asks it again to
 * decide whether to render at all — the second one is the answer that matters,
 * since a hidden link is not a permission.
 */
export function canManageMembers(organization: OrganizationMembership | undefined) {
  return Boolean(organization && organization.type !== "private" && organization.role === "owner");
}

/**
 * Every organization this user is a member of, with the one the session is
 * currently scoped to marked. Scoped the way every read in this app is: the
 * user comes from the session cookie and never from the caller, and the rows
 * are the membership table's answer — not the session's `activeOrganizationId`
 * snapshot, which can point at an organization the user has since been
 * removed from. An active id that no longer appears in the rows simply marks
 * nothing, which is exactly what the projects page shows for it.
 */
export const fetchMyOrganizations = createServerFn({ method: "GET" }).handler(
  async (): Promise<OrganizationMembership[]> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });

    if (!session) return [];

    const rows = await getDB()
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        type: schema.organization.type,
        role: schema.member.role
      })
      .from(schema.organization)
      .innerJoin(
        schema.member,
        and(
          eq(schema.member.organizationId, schema.organization.id),
          eq(schema.member.userId, session.user.id)
        )
      )
      // Name then id, so the menu's order is total and cannot reshuffle
      // between the server render and a client refetch.
      .orderBy(asc(schema.organization.name), asc(schema.organization.id));

    return rows.map((row) => ({
      ...row,
      active: row.id === session.session.activeOrganizationId
    }));
  }
);

/**
 * Keyed under the same prefix as the project lists, so the broad invalidation
 * the project writes already fire refreshes this too — and an organization
 * switch invalidating the prefix catches both in one sweep. Same `staleTime`
 * story as the other reads: the dashboard loader resolves this during SSR,
 * and at 0 the hydrated entry would refetch immediately.
 */
export function myOrganizationsQueryOptions() {
  return queryOptions({
    queryKey: ["organizations", "mine"],
    queryFn: ({ signal }) => fetchMyOrganizations({ signal }),
    staleTime: 30_000
  });
}

/**
 * Points the session at another organization, through better-auth's own
 * endpoint — it re-checks membership server-side and rewrites the session row,
 * which is the one place `activeOrganizationId` lives.
 *
 * Success is only reported after everything that was scoped to the old
 * organization has caught up: the session query (which the `_auth` guard
 * feeds into every route's context), the organization-prefixed reads, and the
 * router's loaders. A switcher that resolved sooner would close onto a grid
 * still showing the previous organization's projects.
 */
export function useSwitchOrganization() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: async (variables: { organizationId: string }) => {
      const { error } = await authClient.organization.setActive({
        organizationId: variables.organizationId
      });

      if (error) throw new Error(error.message ?? "Could not switch organization.");
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["session"] }),
        queryClient.invalidateQueries({ queryKey: ["organizations"] })
      ]);
      await router.invalidate();
    }
  });
}
