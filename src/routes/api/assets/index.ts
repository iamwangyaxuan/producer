import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDB, schema } from "#/db";
import { ALLOWED_MIME, MAX_BYTES } from "#/lib/asset-constraints";
import { getProjectAccess } from "#/server/canvas-access";
import { presignUploadUrl } from "#/server/r2-presign";

import { ASSET_KINDS } from "#/db/schema";

const createInput = z.object({
  projectId: z.uuid(),
  kind: z.enum(ASSET_KINDS),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  // Display-only — it ends up in a DB column and a Content-Disposition header,
  // never in an object key, so length is the only thing worth bounding.
  filename: z.string().trim().min(1).max(255)
});

/**
 * First step of an upload: record what is about to arrive, then hand back a
 * presigned URL the browser PUTs the bytes to directly. The row exists before
 * any byte moves — with its object key already final — so the bucket can
 * never hold an object the database has no record of. Until the completion
 * step flips the row to ready, nothing serves it.
 */
export const Route = createFileRoute("/api/assets/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Expected a JSON body." }, { status: 400 });
        }

        const parsed = createInput.safeParse(body);

        if (!parsed.success) {
          return Response.json({ error: "Invalid upload description." }, { status: 400 });
        }

        const { projectId, kind, mimeType, sizeBytes, filename } = parsed.data;

        if (!ALLOWED_MIME[kind].includes(mimeType)) {
          return Response.json({ error: `Unsupported ${kind} type: ${mimeType}` }, { status: 400 });
        }

        if (sizeBytes > MAX_BYTES[kind]) {
          return Response.json({ error: "File is too large." }, { status: 413 });
        }

        // Project access decides everything else about the row: a forged
        // project id is indistinguishable from a missing one, and the
        // organization the asset lands in comes from this check, never from
        // the client.
        const access = await getProjectAccess(request.headers, projectId);

        if (!access) {
          return Response.json({ error: "That project does not exist." }, { status: 404 });
        }

        const db = getDB();

        // The object key embeds the asset id and must be written with the
        // insert, so the id is fetched first instead of left to the column
        // default — one cheap round trip that keeps ids uuidv7 like every
        // other row.
        const generated = (await db.execute(sql`select uuidv7() as id`)) as unknown as {
          rows: Array<{ id: string }>;
        };
        const assetId = generated.rows[0].id;
        const objectKey = `${access.organizationId}/${projectId}/${assetId}`;

        await db.insert(schema.asset).values({
          id: assetId,
          organizationId: access.organizationId,
          projectId,
          source: "upload",
          kind,
          status: "pending",
          objectKey,
          mimeType,
          sizeBytes,
          filename,
          createdBy: access.userId
        });

        const uploadUrl = await presignUploadUrl(objectKey, mimeType, sizeBytes);

        return Response.json({ assetId, uploadUrl }, { status: 201 });
      }
    }
  }
});
