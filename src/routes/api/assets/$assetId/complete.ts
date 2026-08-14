import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";

import { getDB, schema } from "#/db";
import { MAX_BYTES } from "#/lib/asset-constraints";
import { requireAssetAccess } from "#/server/asset-access";

/**
 * Final step of an upload: the browser has PUT the bytes straight to R2 with
 * its presigned URL, and this is where the row learns they arrived. The
 * object is measured with `head()` rather than trusting anything the client
 * claimed — the measured size is what the row records, and an object that
 * grew past the limit is deleted on the spot.
 */
export const Route = createFileRoute("/api/assets/$assetId/complete")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const access = await requireAssetAccess(request.headers, params.assetId);

        if (!access) {
          return Response.json({ error: "That asset does not exist." }, { status: 404 });
        }

        const { asset, userId } = access;

        // Generations complete themselves server-side; this endpoint only
        // finishes uploads, and only for the person who started one. A ready
        // asset is immutable — its key is cached against — so completing
        // twice is refused rather than repeated.
        if (asset.source !== "upload" || asset.status !== "pending") {
          return Response.json(
            { error: "Nothing here is waiting for an upload." },
            { status: 409 }
          );
        }

        if (asset.createdBy !== userId) {
          return Response.json(
            { error: "Only the uploader can finish an upload." },
            { status: 403 }
          );
        }

        const head = await env.MEDIA.head(asset.objectKey);

        if (!head) {
          return Response.json({ error: "The upload has not arrived." }, { status: 400 });
        }

        // Both writes below re-assert what the read at the top saw — still
        // pending, still undeleted — the same guard `runGeneration`'s bind
        // carries. The read is not a lock: a concurrent `deleteAsset` can
        // tombstone the row between it and here, and an unguarded update
        // would flip a tombstoned row to `ready`, leaving a deleted asset
        // whose row claims to be a live one.
        const stillPending = and(
          eq(schema.asset.id, asset.id),
          eq(schema.asset.status, "pending"),
          isNull(schema.asset.deletedAt)
        );

        // Belt to the signature's braces: the signed Content-Length already
        // stops a longer body reaching the bucket, and this catches anything
        // that got past it. The row is left `failed` rather than deleted, so
        // the sweep still knows the key if the object delete below is lost.
        if (head.size > MAX_BYTES[asset.kind]) {
          await getDB()
            .update(schema.asset)
            .set({ status: "failed", error: "File is too large." })
            .where(stillPending);
          await env.MEDIA.delete(asset.objectKey).catch(() => {});

          return Response.json({ error: "File is too large." }, { status: 413 });
        }

        // The ETag is recorded, not just the size: the presigned URL outlives
        // this call, so the bytes behind the key can still be replaced. The
        // serving route compares what it finds against this and refuses a
        // stranger, which is what makes "a ready asset is immutable" true
        // rather than merely intended.
        const completed = await getDB()
          .update(schema.asset)
          .set({ status: "ready", sizeBytes: head.size, etag: head.etag })
          .where(stillPending)
          .returning({ id: schema.asset.id });

        // Zero rows back: the row moved on mid-call — deleted, most likely.
        // The bytes stay for the tombstone sweep, and the caller hears what
        // any later reader will find.
        if (completed.length === 0) {
          return Response.json({ error: "That asset does not exist." }, { status: 404 });
        }

        // The id and nothing else. A link to the bytes is presigned and short
        // lived, so it is fetched by id when it is needed rather than handed
        // out here, where the caller would be tempted to keep it.
        return Response.json({ assetId: asset.id });
      }
    }
  }
});
