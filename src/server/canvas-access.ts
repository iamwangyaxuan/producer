import { and, eq } from "drizzle-orm";

import { getDB, schema } from "#/db";
import { auth } from "#/lib/auth";
import { canonicalId } from "#/lib/ids";

/**
 * Who the person behind these request headers is to this project — or null if
 * the project is not theirs to touch.
 *
 * The same three questions the project read paths ask: who does the session
 * cookie say this is, is the project in the organization that session is
 * scoped to, and is that person still a member of it. Membership is re-checked
 * rather than trusted from the session's `activeOrganizationId` snapshot,
 * which outlives a revoked membership.
 *
 * **Archived projects answer null unless they are asked for.** That default is
 * the write barrier: every caller that mutates something — starting a
 * generation, creating an upload, opening the collaborative room — gets the
 * refusal without having to remember to ask for it, and archiving stays a thing
 * that stops writes rather than a flag each new endpoint must think about.
 * `allowArchived` is therefore opt-in and used by exactly one kind of caller:
 * the read paths behind the archived canvas, which show the board and offer
 * nothing to do to it.
 *
 * Takes headers rather than a whole request because some callers have only
 * that: the worker holds the upgrade request, the room's revalidation alarm
 * holds the cookie it kept from it.
 */
export interface ProjectAccess {
  organizationId: string;
  userId: string;
  /** True when the project is archived — readable, but closed to every write. */
  archived: boolean;
}

export async function getProjectAccess(
  headers: Headers,
  projectId: string,
  options?: { allowArchived?: boolean }
): Promise<ProjectAccess | null> {
  // The shared shape gate — lowercase uuid, refused before any query. The
  // full rationale (room names fork on case, Postgres raises on malformed
  // literals) lives with `canonicalId`; what matters here is that this is the
  // *same* answer every other entrance gives the same id.
  if (!canonicalId.safeParse(projectId).success) return null;

  const session = await auth.api.getSession({ headers });
  const activeOrganizationId = session?.session.activeOrganizationId;

  if (!session || !activeOrganizationId) return null;

  const rows = await getDB()
    .select({ id: schema.project.id, archived: schema.project.archived })
    .from(schema.project)
    .innerJoin(
      schema.member,
      and(
        eq(schema.member.organizationId, schema.project.organizationId),
        eq(schema.member.userId, session.user.id)
      )
    )
    .where(
      and(eq(schema.project.id, projectId), eq(schema.project.organizationId, activeOrganizationId))
    )
    .limit(1);

  const project = rows[0];

  if (!project) return null;
  if (project.archived && !options?.allowArchived) return null;

  return {
    organizationId: activeOrganizationId,
    userId: session.user.id,
    archived: project.archived
  };
}

/**
 * Whether the person behind these request headers may open the project's
 * *collaborative room* — asked before a socket is accepted, and again
 * periodically while it stays open.
 *
 * An archived project has no room and never gets one: it is served from its
 * saved snapshot instead, which is what makes its canvas read-only by
 * construction rather than by a client that has been asked nicely. So this
 * keeps the default and refuses one.
 */
export async function canAccessProjectCanvas(
  headers: Headers,
  projectId: string
): Promise<boolean> {
  return (await getProjectAccess(headers, projectId)) !== null;
}
