import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDB, schema } from "#/db";
import type { AssetKind, AssetSource } from "#/db/schema";
import { canonicalId } from "#/lib/ids";
import { requireAssetAccess } from "#/server/asset-access";
import { getProjectAccess } from "#/server/canvas-access";

export interface AssetSummary {
  id: string;
  source: AssetSource;
  kind: AssetKind;
  filename: string | null;
  prompt: string | null;
  model: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: Date;
  /** What this file is called — see `assetTitle` for how it is chosen. */
  title: string | null;
}

const projectAssetsInput = z.object({ projectId: canonicalId });

/**
 * A project's stored files, newest first. Only `ready` rows: pending ones are
 * still being written and failed ones have nothing to show — the canvas
 * narrates those states through its nodes, not through this list.
 */
export const fetchProjectAssets = createServerFn({ method: "GET" })
  .validator(projectAssetsInput)
  .handler(async ({ data }): Promise<AssetSummary[]> => {
    const access = await getProjectAccess(getRequest().headers, data.projectId);

    if (!access) return [];

    const rows = await getDB()
      .select({
        id: schema.asset.id,
        source: schema.asset.source,
        kind: schema.asset.kind,
        filename: schema.asset.filename,
        prompt: schema.asset.prompt,
        model: schema.asset.model,
        mimeType: schema.asset.mimeType,
        sizeBytes: schema.asset.sizeBytes,
        createdAt: schema.asset.createdAt,
        title: schema.asset.title
      })
      .from(schema.asset)
      .where(
        and(
          eq(schema.asset.projectId, data.projectId),
          eq(schema.asset.organizationId, access.organizationId),
          eq(schema.asset.status, "ready"),
          isNull(schema.asset.deletedAt)
        )
      )
      .orderBy(desc(schema.asset.createdAt), desc(schema.asset.id));

    return rows;
  });

/**
 * The project's files, for the composer's `@` list.
 *
 * A plain cached read — it carries no links at all, only the rows a consumer
 * derives one from with `assetContentUrl`, so nothing here expires and there
 * is no timer keeping it alive. What invalidates it is a new file arriving,
 * which the upload and generation paths do explicitly.
 */
export function projectAssetsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: projectAssetsScope(projectId),
    queryFn: ({ signal }) => fetchProjectAssets({ data: { projectId }, signal }),
    staleTime: 30_000
  });
}

/** The key a finished upload or generation invalidates to pick up its new file. */
export function projectAssetsScope(projectId: string) {
  return ["projects", projectId, "assets"] as const;
}

const assetInput = z.object({ id: canonicalId });

/**
 * Deletes the asset and its bytes, in the order that can never lie: the
 * tombstone lands first, so the asset is out of serving and listing the
 * moment anything commits, and the R2 object goes second, so a crash between
 * the two leaves stored bytes that the tombstone still knows the key of — a
 * later sweep can finish the job. The reverse order could leave a live row
 * pointing at nothing, which is a user-visible 404 with no explanation.
 *
 * The row itself stays, as a tombstone: it is what keeps the provenance edges
 * of generations that used this file meaningful, and it is the only record of
 * an object key a failed purge would otherwise orphan.
 */
export const deleteAsset = createServerFn({ method: "POST" })
  .validator(assetInput)
  .handler(async ({ data }) => {
    const access = await requireAssetAccess(getRequest().headers, data.id);

    if (!access) throw new Error("That asset no longer exists.");

    await getDB()
      .update(schema.asset)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(schema.asset.id, data.id), isNull(schema.asset.deletedAt)));

    try {
      // Idempotent: deleting a key with nothing behind it is a no-op, so a
      // pending asset whose bytes never arrived takes this path unbothered.
      await env.MEDIA.delete(access.asset.objectKey);
    } catch (error) {
      // The user-facing delete has already happened; the bytes are cleanup,
      // and the tombstone keeps them findable if this attempt is lost.
      console.error(`failed to delete R2 object ${access.asset.objectKey}`, error);
    }

    return { id: data.id };
  });
