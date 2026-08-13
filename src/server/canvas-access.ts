import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDB, schema } from "#/db";
import { auth } from "#/lib/auth";

const projectIdShape = z.uuid();

/**
 * Who the person behind these request headers is to this project — or null if
 * the project is not theirs to touch.
 *
 * The same three questions the project read paths ask: who does the session
 * cookie say this is, is the project in the organization that session is
 * scoped to, and is that person still a member of it. Membership is re-checked
 * rather than trusted from the session's `activeOrganizationId` snapshot,
 * which outlives a revoked membership; and an archived project answers null
 * for the reason it answers "not found" over HTTP — nothing in the app can
 * reach it, so nothing should be able to write into it either.
 *
 * Takes headers rather than a whole request because some callers have only
 * that: the worker holds the upgrade request, the room's revalidation alarm
 * holds the cookie it kept from it.
 */
export async function getProjectAccess(
  headers: Headers,
  projectId: string
): Promise<{ organizationId: string; userId: string } | null> {
  // Checked before it goes anywhere near a query: a malformed literal compared
  // against a `uuid` column makes Postgres raise instead of returning no rows.
  //
  // Lowercase is required, not normalized. The room name becomes a Durable
  // Object id byte-for-byte, so `ABC…` and `abc…` are two different rooms even
  // though Postgres would happily match either against the same project row —
  // an uppercased URL would pass the membership check and then quietly fork
  // the canvas into a second, invisible document. Every id this app generates
  // is lowercase; anything else is a hand-mangled URL and can be refused.
  if (projectId !== projectId.toLowerCase()) return null;
  if (!projectIdShape.safeParse(projectId).success) return null;

  const session = await auth.api.getSession({ headers });
  const activeOrganizationId = session?.session.activeOrganizationId;

  if (!session || !activeOrganizationId) return null;

  const rows = await getDB()
    .select({ id: schema.project.id })
    .from(schema.project)
    .innerJoin(
      schema.member,
      and(
        eq(schema.member.organizationId, schema.project.organizationId),
        eq(schema.member.userId, session.user.id)
      )
    )
    .where(
      and(
        eq(schema.project.id, projectId),
        eq(schema.project.organizationId, activeOrganizationId),
        eq(schema.project.archived, false)
      )
    )
    .limit(1);

  if (rows.length === 0) return null;

  return { organizationId: activeOrganizationId, userId: session.user.id };
}

/**
 * Whether the person behind these request headers may open the project's
 * canvas — asked before a socket is accepted, and again periodically while it
 * stays open.
 */
export async function canAccessProjectCanvas(
  headers: Headers,
  projectId: string
): Promise<boolean> {
  return (await getProjectAccess(headers, projectId)) !== null;
}
