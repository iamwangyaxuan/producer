import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDB, schema } from "#/db";
import { ASSET_KINDS } from "#/db/schema";
import { ALLOWED_MIME } from "#/lib/asset-constraints";
import { requireAssetAccess } from "#/server/asset-access";
import { getProjectAccess } from "#/server/canvas-access";
import { getProvider } from "#/server/generation/provider";

import type { GenerationParams } from "#/db/schema";

/**
 * Generation in two calls, so the record exists before the work does.
 *
 * `startGeneration` verifies the project is the caller's to write into and
 * inserts the pending asset row — object key already final — answering with
 * the id at once. The caller binds that id to its canvas node *before* any
 * model runs, which is what lets everything that happens mid-generation — the
 * node deleted, the tab closed — talk about the asset by name instead of
 * leaving an unowned row behind.
 *
 * `runGeneration` does the slow part: provider, R2, and then binding the
 * bytes to the row — an update guarded on the row still being pending and
 * undeleted. If the asset was deleted while the model worked, the bind
 * misses and the freshly written object is removed on the spot; bytes never
 * outlive the record that names them.
 *
 * Client-side generation could not grow into this: a real provider's API key
 * cannot live in a browser, and a server asked to persist whatever URL a
 * client hands it is an SSRF waiting to happen. The stub lives behind the
 * same server-side seam a real provider will occupy.
 */

const startInput = z.object({
  projectId: z.uuid(),
  modality: z.enum(ASSET_KINDS),
  prompt: z.string().trim().min(1).max(10_000),
  model: z.string().min(1).max(200),
  resolution: z.string().max(50).optional(),
  aspectRatio: z.string().max(50).optional(),
  duration: z.number().positive().max(600).optional(),
  /** Assets fed in as inputs — carried through to the reference table now,
   * populated by the composer the day it grows a file picker. */
  referenceAssetIds: z.array(z.uuid()).max(8).default([])
});

export const startGeneration = createServerFn({ method: "POST" })
  .validator(startInput)
  .handler(async ({ data }): Promise<{ assetId: string }> => {
    const access = await getProjectAccess(getRequest().headers, data.projectId);

    if (!access) throw new Error("That project no longer exists.");

    const db = getDB();

    // The client's reference list is a claim, not a fact: every id must be a
    // ready asset of this same project. Counting the survivors and comparing
    // is what rejects a forged or foreign id without saying which one it was.
    const referenceIds = [...new Set(data.referenceAssetIds)];

    if (referenceIds.length > 0) {
      const found = await db
        .select({ id: schema.asset.id })
        .from(schema.asset)
        .where(
          and(
            inArray(schema.asset.id, referenceIds),
            eq(schema.asset.organizationId, access.organizationId),
            eq(schema.asset.projectId, data.projectId),
            eq(schema.asset.status, "ready"),
            isNull(schema.asset.deletedAt)
          )
        );

      if (found.length !== referenceIds.length) {
        throw new Error("A referenced asset no longer exists.");
      }
    }

    // Request parameters as given, minus the undefineds — this is the
    // re-run/display record, not measured output.
    const params: GenerationParams = {};
    if (data.resolution !== undefined) params.resolution = data.resolution;
    if (data.aspectRatio !== undefined) params.aspectRatio = data.aspectRatio;
    if (data.duration !== undefined) params.duration = data.duration;

    // The object key embeds the asset id and is NOT NULL from the first
    // insert, so the id is fetched ahead of the row instead of left to the
    // column default — one cheap round trip that keeps ids uuidv7.
    const generated = (await db.execute(sql`select uuidv7() as id`)) as unknown as {
      rows: Array<{ id: string }>;
    };
    const assetId = generated.rows[0].id;
    const objectKey = `${access.organizationId}/${data.projectId}/${assetId}`;

    // Row and lineage land together: a generation whose reference edges were
    // lost to a crash would claim to be made from nothing.
    await db.transaction(async (tx) => {
      await tx.insert(schema.asset).values({
        id: assetId,
        organizationId: access.organizationId,
        projectId: data.projectId,
        source: "ai",
        kind: data.modality,
        status: "pending",
        objectKey,
        prompt: data.prompt,
        model: data.model,
        params,
        createdBy: access.userId
      });

      if (referenceIds.length > 0) {
        await tx.insert(schema.assetReference).values(
          referenceIds.map((referencedAssetId, position) => ({
            assetId,
            referencedAssetId,
            position
          }))
        );
      }
    });

    return { assetId };
  });

const runInput = z.object({ assetId: z.uuid() });

export const runGeneration = createServerFn({ method: "POST" })
  .validator(runInput)
  .handler(async ({ data }): Promise<{ assetId: string; url: string; mimeType: string }> => {
    const request = getRequest();
    const access = await requireAssetAccess(request.headers, data.assetId);

    if (!access) throw new Error("That asset no longer exists.");

    const { asset, userId } = access;

    // Everything the model needs was recorded at start time; nothing about
    // the request is trusted from this second call beyond the id — a caller
    // cannot re-run a finished asset or run someone else's pending one.
    if (asset.source !== "ai" || asset.status !== "pending" || asset.createdBy !== userId) {
      throw new Error("That asset is not waiting to be generated.");
    }

    const db = getDB();

    let stored;
    try {
      const result = await getProvider(asset.model ?? "").run(
        {
          modality: asset.kind,
          prompt: asset.prompt ?? "",
          model: asset.model ?? "",
          resolution: asset.params?.resolution,
          aspectRatio: asset.params?.aspectRatio,
          duration: asset.params?.duration
        },
        // The incoming request's own signal: it fires if the caller stops
        // waiting, which is worth honouring while the provider is only
        // pretending to work anyway.
        request.signal
      );

      // What a provider says it sent is a claim, and this one is about to be
      // stored and later served from the app's own origin. A type outside
      // the kind's allowlist fails the generation rather than being kept:
      // the serving route would have to refuse to render it anyway, and a
      // row that cannot be shown is better named a failure than a result.
      const contentType = result.contentType.split(";")[0].trim().toLowerCase();

      if (!ALLOWED_MIME[asset.kind].includes(contentType)) {
        throw new Error(`Provider answered with an unsupported ${asset.kind} type.`);
      }

      // R2 refuses a stream it cannot size, so a stream rides through a
      // FixedLengthStream sized by the provider's declared length; a pipe
      // failure surfaces through the put, not as an unhandled rejection.
      let body: ReadableStream | ArrayBuffer = result.body;

      if (body instanceof ReadableStream) {
        if (result.contentLength === undefined) {
          body = await new Response(body).arrayBuffer();
        } else {
          const fixed = new FixedLengthStream(result.contentLength);
          void body.pipeTo(fixed.writable).catch(() => {});
          body = fixed.readable;
        }
      }

      stored = {
        object: await env.MEDIA.put(asset.objectKey, body, {
          httpMetadata: { contentType }
        }),
        contentType
      };
    } catch (error) {
      // Best effort, and guarded like the bind below: a row deleted while
      // the model worked is not this call's to rewrite. If even this is
      // lost, the row stays pending and the stale-pending sweep resolves it.
      await db
        .update(schema.asset)
        .set({ status: "failed", error: error instanceof Error ? error.message : "Generation failed." })
        .where(
          and(
            eq(schema.asset.id, asset.id),
            eq(schema.asset.status, "pending"),
            isNull(schema.asset.deletedAt)
          )
        )
        .catch(() => {});

      throw new Error("Generation failed.");
    }

    // The bind: bytes become the record's only if the record is still the one
    // that asked for them. Guarding on pending-and-undeleted is what makes a
    // mid-generation delete clean — the update misses, and the object just
    // written is removed rather than left to outlive its tombstoned row.
    const bound = await db
      .update(schema.asset)
      .set({
        status: "ready",
        mimeType: stored.contentType,
        sizeBytes: stored.object.size,
        etag: stored.object.etag
      })
      .where(
        and(
          eq(schema.asset.id, asset.id),
          eq(schema.asset.status, "pending"),
          isNull(schema.asset.deletedAt)
        )
      )
      .returning({ id: schema.asset.id });

    if (bound.length === 0) {
      // The bytes are left where they are. A miss means the row moved on
      // without this call — deleted, or bound by a run that raced this one —
      // and deleting the object here would, in the second case, destroy the
      // very bytes the winner just published. Whatever is unreferenced is
      // reachable from the row's own `objectKey`, which the sweep collects.
      throw new Error("That asset no longer exists.");
    }

    return {
      assetId: asset.id,
      url: `/api/assets/${asset.id}/content`,
      // The serving URL carries no extension, so players that route by type
      // need telling what is behind it.
      mimeType: stored.contentType
    };
  });
