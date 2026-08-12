import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDB, schema } from "#/db";
import { auth } from "#/lib/auth";

const projectIdShape = z.uuid();

/**
 * Whether the person behind these request headers may open the project's
 * canvas.
 *
 * The same three questions the project read paths ask, asked before a socket
 * is accepted — and again periodically while it stays open: who does the
 * session cookie say this is, is the project in the organization that session
 * is scoped to, and is that person still a member of it. Membership is
 * re-checked rather than trusted from the session's `activeOrganizationId`
 * snapshot, which outlives a revoked membership; and an archived project
 * answers no for the reason it answers "not found" over HTTP — nothing in the
 * app can reach it, so nothing should be able to sync with it either.
 *
 * Takes headers rather than a whole request because both callers have only
 * that: the worker holds the upgrade request, the room's revalidation alarm
 * holds the cookie it kept from it.
 */
export async function canAccessProjectCanvas(
  headers: Headers,
  projectId: string
): Promise<boolean> {
  // Checked before it goes anywhere near a query: a malformed literal compared
  // against a `uuid` column makes Postgres raise instead of returning no rows.
  //
  // Lowercase is required, not normalized. The room name becomes a Durable
  // Object id byte-for-byte, so `ABC…` and `abc…` are two different rooms even
  // though Postgres would happily match either against the same project row —
  // an uppercased URL would pass the membership check and then quietly fork
  // the canvas into a second, invisible document. Every id this app generates
  // is lowercase; anything else is a hand-mangled URL and can be refused.
  if (projectId !== projectId.toLowerCase()) return false;
  if (!projectIdShape.safeParse(projectId).success) return false;

  const session = await auth.api.getSession({ headers });
  const activeOrganizationId = session?.session.activeOrganizationId;

  if (!session || !activeOrganizationId) return false;

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

  return rows.length > 0;
}
