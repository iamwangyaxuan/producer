import { getRequest } from "@tanstack/react-start/server";
import { and, eq } from "drizzle-orm";

import { getDB, schema } from "#/db";
import { auth } from "#/lib/auth";

/**
 * Who is asking, about which organization, and whether they may spend its
 * money.
 *
 * Its own module because two features need the same answer — the wallet and the
 * organization's Gateway key — and the second must not have to import the first
 * to get it, which would drag Stripe and the whole checkout in behind it.
 *
 * The split it encodes is the one the rest of the app already draws.
 * **Spending** is any member's: it happens through the canvas, where
 * `getProjectAccess` has established membership, and a team where only the
 * owner can generate is not a team. **Changing what is being paid for** — top
 * ups, the statement, whose API key is used — belongs to the roles that already
 * control the seat subscription.
 */

/** Roles that may spend an organization's money, matching `organization.ts`. */
export const BILLING_ROLES = new Set(["owner", "admin"]);

/**
 * Thrown by {@link requireBillingAccess}. A distinct type because the endpoints
 * that catch errors on the way to a browser have to be able to tell "you may
 * not do this" — which is written for the person reading it — from a failure
 * whose message must be replaced.
 */
export class BillingAccessError extends Error {}

export interface BillingViewer {
  userId: string;
  organizationId: string;
  organizationName: string;
  role: string;
}

/**
 * Resolved the way every scoped read here resolves it: user from the session
 * cookie, organization from that session's `activeOrganizationId`, and
 * membership re-checked against `member` rather than trusted from the snapshot,
 * which outlives a revoked membership.
 *
 * `null` covers no session, no active organization, and a membership that is
 * gone. All three are the same answer on purpose.
 */
export async function readBillingViewer(): Promise<BillingViewer | null> {
  const session = await auth.api.getSession({ headers: getRequest().headers });
  const activeOrganizationId = session?.session.activeOrganizationId;

  if (!session || !activeOrganizationId) return null;

  // One statement for two questions: which organization this is, and what this
  // user is in it. The join is the membership check.
  const [row] = await getDB()
    .select({ name: schema.organization.name, role: schema.member.role })
    .from(schema.organization)
    .innerJoin(
      schema.member,
      and(
        eq(schema.member.organizationId, schema.organization.id),
        eq(schema.member.userId, session.user.id)
      )
    )
    .where(eq(schema.organization.id, activeOrganizationId))
    .limit(1);

  if (!row) return null;

  return {
    userId: session.user.id,
    organizationId: activeOrganizationId,
    organizationName: row.name,
    role: row.role
  };
}

/**
 * The same, for the endpoints that move money or change who pays.
 *
 * The role check is here rather than only in the page. A hidden control is not
 * a permission, and every one of these is a plain HTTP route that anyone signed
 * in can call.
 */
export async function requireBillingAccess(): Promise<BillingViewer> {
  const viewer = await readBillingViewer();

  if (!viewer || !BILLING_ROLES.has(viewer.role)) {
    throw new BillingAccessError("You cannot manage billing for this organization.");
  }

  return viewer;
}
