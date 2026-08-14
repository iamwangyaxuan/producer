import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDB, schema } from "#/db";
import { canonicalId } from "#/lib/ids";

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

    // `auth.ts` backfills a private organization when a session is created, but
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

/** Exactly what the studio needs to name itself; the rest of the row stays put. */
export interface ProjectDetail {
  id: string;
  name: string;
}

/**
 * Unlike the writes further down, the id is not rejected as malformed before the
 * handler runs. It arrives straight out of the URL, so a mistyped path has to
 * reach the same "no such project" answer as a well-formed id matching nothing,
 * rather than an error screen. The shape is still checked inside, with the same
 * `canonicalId` every other entrance uses: an uppercased id must answer "no
 * such project" *here* too, or the studio shell loads while the canvas socket,
 * generation and upload — whose gates all refuse it — answer 401 for the same
 * URL.
 */
const projectDetailInput = z.object({ id: z.string() });

/**
 * The single-project counterpart of the list read, scoped the same way: the
 * organization comes from the session cookie and never from the caller, and
 * membership is re-checked rather than trusted from `activeOrganizationId`,
 * which is a snapshot that outlives a revoked membership. The join does both in
 * one statement, so a project belonging to another tenant is indistinguishable
 * from one that never existed.
 */
export const fetchProject = createServerFn({ method: "GET" })
  .validator(projectDetailInput)
  .handler(async ({ data }): Promise<ProjectDetail | null> => {
    if (!canonicalId.safeParse(data.id).success) return null;

    const session = await auth.api.getSession({ headers: getRequest().headers });
    const activeOrganizationId = session?.session.activeOrganizationId;

    if (!session || !activeOrganizationId) return null;

    const rows = await getDB()
      .select({ id: schema.project.id, name: schema.project.name })
      .from(schema.project)
      .innerJoin(
        schema.member,
        and(
          eq(schema.member.organizationId, schema.project.organizationId),
          eq(schema.member.userId, session.user.id)
        )
      )
      // Archived projects answer as missing for the reason the list hides them:
      // nothing in the app can un-archive one, so opening it would be a dead end.
      .where(
        and(
          eq(schema.project.id, data.id),
          eq(schema.project.organizationId, activeOrganizationId),
          eq(schema.project.archived, false)
        )
      )
      .limit(1);

    return rows[0] ?? null;
  });

/**
 * Keyed under the same prefix as the list, so the invalidation the writes below
 * already fire reaches this entry too — a rename cannot leave a stale name
 * cached behind the studio. `organizationId` plays the part it plays there: it
 * never travels to the server, it only stops one tenant's answer from being
 * painted for another. Same `staleTime`, for the same reason — the route loader
 * resolves this key during SSR, and at 0 the hydrated entry would immediately
 * refetch it.
 */
export function projectQueryOptions(organizationId: string | null | undefined, projectId: string) {
  return queryOptions({
    queryKey: ["organizations", organizationId ?? null, "projects", projectId],
    queryFn: ({ signal }) => fetchProject({ data: { id: projectId }, signal }),
    staleTime: 30_000
  });
}

/** Long enough for a sentence, short enough that a card can still show one. */
export const PROJECT_NAME_MAX_LENGTH = 120;

/**
 * The write path's half of the scoping `fetchOrganizationProjects` does inline:
 * the tenant comes from the session cookie, never from the caller, and
 * membership is re-checked on every call for the same reason the read path
 * checks it — `activeOrganizationId` is a snapshot that outlives a revoked
 * membership.
 *
 * Throwing rather than returning a sentinel: unlike the read, there is no
 * sensible empty answer to "rename this project" from someone who may not.
 */
async function requireActiveOrganization() {
  const session = await auth.api.getSession({ headers: getRequest().headers });
  const activeOrganizationId = session?.session.activeOrganizationId;

  if (!session || !activeOrganizationId) throw new Error("No active organization.");

  const db = getDB();

  const memberships = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, activeOrganizationId),
        eq(schema.member.userId, session.user.id)
      )
    )
    .limit(1);

  if (memberships.length === 0) throw new Error("No active organization.");

  return { db, organizationId: activeOrganizationId };
}

/**
 * Every write takes the project id from the client and the organization from
 * the cookie, then asks for both in the same `where`. A project id belonging to
 * another tenant matches nothing, so a forged id is indistinguishable from one
 * that no longer exists — which is exactly what it should look like from
 * outside.
 */
const projectInput = z.object({ id: z.uuid() });

const renameInput = z.object({
  id: z.uuid(),
  // Trimmed before the length check, so a name of nothing but spaces is
  // rejected rather than stored — `name` is NOT NULL but has no such opinion.
  name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH)
});

/** Zero rows back means the id matched nothing this organization owns. */
const NOT_FOUND = "That project no longer exists.";

export const renameProject = createServerFn({ method: "POST" })
  .validator(renameInput)
  .handler(async ({ data }) => {
    const { db, organizationId } = await requireActiveOrganization();

    const updated = await db
      .update(schema.project)
      .set({ name: data.name })
      .where(and(eq(schema.project.id, data.id), eq(schema.project.organizationId, organizationId)))
      .returning({ id: schema.project.id });

    if (updated.length === 0) throw new Error(NOT_FOUND);

    return { id: data.id, name: data.name };
  });

/**
 * Archiving only hides the project: the list filters `archived` out, so the row
 * survives with everything hanging off it. Nothing in the app can un-archive
 * one yet, which is why the confirmation that fronts this says so.
 */
export const archiveProject = createServerFn({ method: "POST" })
  .validator(projectInput)
  .handler(async ({ data }) => {
    const { db, organizationId } = await requireActiveOrganization();

    const updated = await db
      .update(schema.project)
      .set({ archived: true })
      .where(and(eq(schema.project.id, data.id), eq(schema.project.organizationId, organizationId)))
      .returning({ id: schema.project.id });

    if (updated.length === 0) throw new Error(NOT_FOUND);

    return { id: data.id };
  });

/** The row itself, not a flag on it. There is no undo in front of this one. */
export const deleteProject = createServerFn({ method: "POST" })
  .validator(projectInput)
  .handler(async ({ data }) => {
    const { db, organizationId } = await requireActiveOrganization();

    const deleted = await db
      .delete(schema.project)
      .where(and(eq(schema.project.id, data.id), eq(schema.project.organizationId, organizationId)))
      .returning({ id: schema.project.id });

    if (deleted.length === 0) throw new Error(NOT_FOUND);

    return { id: data.id };
  });

/**
 * Every project list in the cache, whichever organization it is keyed to. A
 * write only ever touches the active one, but the prefix costs nothing to
 * invalidate — an unmounted list refetches when something mounts it again, not
 * now — and it means an organization switch cannot leave a stale grid behind.
 */
const PROJECT_LIST_SCOPE = ["organizations"];

/**
 * The shared half of the three hooks below. The invalidation is *returned*
 * rather than fired and forgotten, so the mutation stays pending until the grid
 * has the new rows: a dialog that closes on success closes onto a card that has
 * already caught up, instead of the one it was editing.
 */
function useProjectMutation<TVariables>(mutationFn: (variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECT_LIST_SCOPE })
  });
}

export function useRenameProject() {
  return useProjectMutation((data: { id: string; name: string }) => renameProject({ data }));
}

export function useArchiveProject() {
  return useProjectMutation((data: { id: string }) => archiveProject({ data }));
}

export function useDeleteProject() {
  return useProjectMutation((data: { id: string }) => deleteProject({ data }));
}
