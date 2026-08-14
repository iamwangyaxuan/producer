import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDB, newRowId, schema } from "#/db";
import { ASSET_KINDS } from "#/db/schema";
import { ALLOWED_MIME, MAX_BYTES, normalizeMime } from "#/lib/asset-constraints";
import { assetTitle } from "#/lib/asset-links";
import { getProjectAccess } from "#/server/canvas-access";
import { presignUploadUrl } from "#/server/r2-presign";

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

        const { projectId, kind, sizeBytes, filename } = parsed.data;

        // Judged, signed and stored in one canonical spelling. Keeping the
        // client's own spelling for the signature — as this once did, so the
        // browser could PUT `file.type` verbatim — let anything the allowlist
        // ignores ride along into the bucket: `normalizeMime` compares only the
        // part before the first `;`, so `image/png;x=1,text/html` passes the
        // check as `image/png` and then lands as the object's stored
        // `Content-Type`. Nothing serves that value today, but an object whose
        // metadata contradicts its row is a trap for whatever reads it next.
        //
        // Signing the normalized form instead means R2 will only accept a PUT
        // that declares exactly that, which is why the client is told below
        // what to send rather than left to repeat its own guess.
        const mimeType = normalizeMime(parsed.data.mimeType);

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
        // default — see `newRowId`.
        const assetId = await newRowId(db);
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
          // An upload arrives already named — the person called it something,
          // and that is the title. The extension comes off because it is
          // re-derived from the stored type wherever a filename is needed,
          // and keeping it here would produce `photo.png.png`.
          title: assetTitle({ kind, title: null, filename, prompt: null, mimeType }),
          createdBy: access.userId
        });

        let uploadUrl: string;
        try {
          uploadUrl = await presignUploadUrl(objectKey, mimeType, sizeBytes);
        } catch (error) {
          // The row was inserted for a URL that now cannot exist, so no byte
          // will ever arrive for it — deleting it outright beats leaving a
          // pending row for the sweep's 24-hour grace to collect. If even the
          // delete is lost, that sweep is still the backstop.
          console.error(`failed to presign upload for asset ${assetId}`, error);
          await db
            .delete(schema.asset)
            .where(eq(schema.asset.id, assetId))
            .catch(() => {});

          return Response.json({ error: "Upload could not be prepared." }, { status: 500 });
        }

        // `contentType` is not advice: it is the exact string the signature
        // covers, so a PUT sending anything else — including the browser's own
        // spelling of the same type — is refused by R2.
        return Response.json({ assetId, uploadUrl, contentType: mimeType }, { status: 201 });
      }
    }
  }
});
