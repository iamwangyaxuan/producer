import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDB, schema } from "#/db";
import { auth } from "#/lib/auth";

const assetIdShape = z.uuid();

export type AssetRow = typeof schema.asset.$inferSelect;

export interface AssetAccess {
  asset: AssetRow;
  userId: string;
}

/**
 * The asset row behind this id — or null if it is not this person's to see.
 *
 * Same rules as project and canvas access: the session cookie names the
 * person, the asset must live in the organization the session is scoped to,
 * and membership of that organization is re-checked rather than trusted from
 * the session's `activeOrganizationId` snapshot, which outlives a revoked
 * membership. Soft-deleted rows are filtered here so every consumer — serving,
 * upload completion, deletion — agrees they no longer exist. A null answer is
 * indistinguishable from "no such asset", which is the point.
 *
 * Takes headers rather than a request so both file routes and server
 * functions can call it with what they have.
 */
export async function requireAssetAccess(
  headers: Headers,
  assetId: string
): Promise<AssetAccess | null> {
  // Same shape guard as canvas access: a malformed literal against a `uuid`
  // column makes Postgres raise instead of returning no rows, and every id
  // this app mints is lowercase, so anything else can be refused unqueried.
  if (assetId !== assetId.toLowerCase()) return null;
  if (!assetIdShape.safeParse(assetId).success) return null;

  const session = await auth.api.getSession({ headers });
  const activeOrganizationId = session?.session.activeOrganizationId;

  if (!session || !activeOrganizationId) return null;

  const rows = await getDB()
    .select()
    .from(schema.asset)
    .innerJoin(
      schema.member,
      and(
        eq(schema.member.organizationId, schema.asset.organizationId),
        eq(schema.member.userId, session.user.id)
      )
    )
    .where(
      and(
        eq(schema.asset.id, assetId),
        eq(schema.asset.organizationId, activeOrganizationId),
        isNull(schema.asset.deletedAt)
      )
    )
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  return { asset: row.asset, userId: session.user.id };
}
