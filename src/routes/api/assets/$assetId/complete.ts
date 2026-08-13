import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

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
          return Response.json({ error: "Nothing here is waiting for an upload." }, { status: 409 });
        }

        if (asset.createdBy !== userId) {
          return Response.json({ error: "Only the uploader can finish an upload." }, { status: 403 });
        }

        const head = await env.MEDIA.head(asset.objectKey);

        if (!head) {
          return Response.json({ error: "The upload has not arrived." }, { status: 400 });
        }

        if (head.size > MAX_BYTES[asset.kind]) {
          await env.MEDIA.delete(asset.objectKey);
          await getDB()
            .update(schema.asset)
            .set({ status: "failed", error: "File is too large." })
            .where(eq(schema.asset.id, asset.id));

          return Response.json({ error: "File is too large." }, { status: 413 });
        }

        await getDB()
          .update(schema.asset)
          .set({ status: "ready", sizeBytes: head.size })
          .where(eq(schema.asset.id, asset.id));

        return Response.json({
          assetId: asset.id,
          url: `/api/assets/${asset.id}/content`
        });
      }
    }
  }
});
