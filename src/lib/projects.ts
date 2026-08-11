import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, desc, eq } from "drizzle-orm";

import { getDB, schema } from "#/db";

import { auth } from "./auth";

/**
 * The grid has no pagination yet, so the read is capped instead of streaming a
 * whole table into the SSR document. One extra row is fetched so `hasMore` can
 * say the list is a slice rather than silently pretending it is everything.
 */
const PROJECT_LIST_LIMIT = 60;

/** Exactly what a card renders — the row travels to the browser, so nothing else ships. */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
}

export interface OrganizationProjects {
  /**
   * The organization the server actually scoped the read to — not one the caller
   * asked for, because the caller never gets to ask. `null` means the session
   * carries no active organization, or the user is no longer a member of the one
   * it points at.
   */
  organization: { id: string; name: string } | null;
  projects: ProjectSummary[];
  /** More rows matched than were returned; the list is a truncated slice. */
  hasMore: boolean;
}

/** Nothing this user is allowed to see, for any of the reasons above. */
const NO_ORGANIZATION: OrganizationProjects = {
  organization: null,
  projects: [],
  hasMore: false
};

/**
 * A server function is a plain HTTP endpoint — the `_auth` route guard does not
 * stand in front of it — so the tenant scope is resolved here, from the session
 * cookie. The handler deliberately takes no input at all: there is no
 * organization id a client could forge, which is a stronger guarantee than
 * accepting one and remembering to validate it.
 */
export const fetchOrganizationProjects = createServerFn({ method: "GET" }).handler(
  async (): Promise<OrganizationProjects> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });
    const activeOrganizationId = session?.session.activeOrganizationId;

    // `auth.ts` backfills a personal organization when a session is created, but
    // the column is nullable, so this is a real branch rather than an assertion
    // waiting to be deleted. Turning a missing session into a redirect is the
    // `_auth` guard's job; all this path has to do is avoid an unscoped read.
    if (!session || !activeOrganizationId) return NO_ORGANIZATION;

    const db = getDB();

    // Both statements are scoped to the same id, so they go out together and
    // cost one round trip: the membership check decides whether the rows may be
    // returned, not which rows to read. The check itself is not optional —
    // `activeOrganizationId` is a snapshot written into the session row, and
    // better-auth only clears it when a user removes *themselves*. An admin
    // removing someone leaves their sessions pointing at the organization they
    // just lost, so trusting the column alone would keep a revoked member
    // reading this list until their session expired. Selecting the name in the
    // same statement is what lets the header and the empty state still name the
    // organization when it holds no projects at all.
    const [memberships, rows] = await Promise.all([
      db
        .select({ id: schema.organization.id, name: schema.organization.name })
        .from(schema.organization)
        .innerJoin(
          schema.member,
          and(
            eq(schema.member.organizationId, schema.organization.id),
            eq(schema.member.userId, session.user.id)
          )
        )
        .where(eq(schema.organization.id, activeOrganizationId))
        .limit(1),
      db
        .select({
          id: schema.project.id,
          name: schema.project.name,
          description: schema.project.description,
          image: schema.project.image
        })
        .from(schema.project)
        // Archived projects are hidden because nothing in the app can un-archive
        // one yet; listing them would be a dead end with no way out of it.
        .where(
          and(
            eq(schema.project.organizationId, activeOrganizationId),
            eq(schema.project.archived, false)
          )
        )
        // Most recently touched first. `name` then `id` break ties so the order
        // is total: rows sharing a timestamp must not swap places between the
        // server render and a later client refetch, or the grid reshuffles.
        // `updatedAt` orders the read without being selected — the cards do not
        // show a timestamp, so it never has to cross the wire.
        .orderBy(desc(schema.project.updatedAt), asc(schema.project.name), asc(schema.project.id))
        // One extra row is the cheapest way to learn there is more after these.
        .limit(PROJECT_LIST_LIMIT + 1)
    ]);

    const organization = memberships[0];

    // Read, but never returned: the membership check failed, so these rows are
    // not this user's to see.
    if (!organization) return NO_ORGANIZATION;

    return {
      organization,
      projects: rows.slice(0, PROJECT_LIST_LIMIT),
      hasMore: rows.length > PROJECT_LIST_LIMIT
    };
  }
);

/**
 * `organizationId` keys the cache and is never sent anywhere — the server
 * derives the real scope itself. Keying on it is what stops a tab that switches
 * organization, or signs in as somebody else without a full reload, from
 * painting the previous tenant's cached list out of memory. The server decides
 * what is *read*; the key only decides what is *remembered*.
 *
 * `staleTime` is load bearing rather than a tuning knob. The query client is
 * built with no defaults, so at 0 the SSR-dehydrated entry is already stale the
 * moment it hydrates and `useSuspenseQuery` refetches it immediately — every
 * page load would cost a second round trip and a second session lookup. Worse,
 * `useSuspenseQuery` throws on error, so one flaky background refetch would
 * replace an already-rendered grid with the error screen.
 */
export function organizationProjectsQueryOptions(organizationId: string | null | undefined) {
  return queryOptions({
    queryKey: ["organizations", organizationId ?? null, "projects"],
    queryFn: ({ signal }) => fetchOrganizationProjects({ signal }),
    staleTime: 30_000
  });
}
