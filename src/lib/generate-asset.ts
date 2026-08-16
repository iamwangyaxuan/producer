import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDB, newRowId, schema } from "#/db";
import { ASSET_KINDS } from "#/db/schema";
import type { GenerationParams } from "#/db/schema";
import { ALLOWED_MIME, normalizeMime } from "#/lib/asset-constraints";
import { canonicalId } from "#/lib/ids";
import { findModel } from "#/lib/models";
import { INSUFFICIENT_CREDITS_MESSAGE, quoteGeneration } from "#/lib/pricing";
import type { GenerationQuote } from "#/lib/pricing";
import { withRetry } from "#/lib/retry";
import { requireAssetAccess } from "#/server/asset-access";
import { assetDownloadUrl } from "#/server/asset-url";
import { debit, InsufficientCredits, readBalance, refundCharge } from "#/server/billing/credits";
import type { LedgerEntry } from "#/server/billing/credits";
import { getProjectAccess } from "#/server/canvas-access";
import { resolveGateway } from "#/server/generation/gateway";
import type { ResolvedGateway } from "#/server/generation/gateway";
import { meterInBackground, recordUsageEvent } from "#/server/generation/metering";
import { getProvider } from "#/server/generation/provider";
import type { GenerationReference, GenerationResult } from "#/server/generation/provider";
import { generateAssetTitle, TITLE_MODEL } from "#/server/generation/title";

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
 * `runGeneration` does the slow part: claiming the row, then provider, R2,
 * and binding the bytes to the row — an update guarded on the row still
 * being pending and undeleted. If the asset was deleted while the model
 * worked, the bind misses and the bytes are left where they are: the row's
 * own `objectKey` still names them, and the tombstone sweep collects them.
 * Deleting here instead would race a concurrent run — see the bind below.
 *
 * Client-side generation could not grow into this: a real provider's API key
 * cannot live in a browser, and a server asked to persist whatever URL a
 * client hands it is an SSRF waiting to happen. The stub lives behind the
 * same server-side seam a real provider will occupy.
 */

/**
 * What this request will cost, decided from the server's own facts.
 *
 * The client quotes the same request with the same function to put a price on
 * the send button, but never sends the answer: a price arriving in a request
 * body is a price the caller chose. Both sides read `models.ts`, and the one
 * part the browser cannot work out — whether this generation is billed at all —
 * travels on the wallet query instead.
 *
 * "Billed at all" is exactly `source === "system"`. An organization running on
 * its own Gateway key has already been charged by Vercel for the call, so
 * charging its wallet as well would be charging twice for one generation; an
 * organization with no gateway of any kind gets a stand-in file, which is not
 * something to charge for either. Both collapse to a zero quote, and the wallet
 * is never touched for a zero.
 */
function quoteFor(
  request: {
    model?: string | null;
    prompt?: string | null;
    params?: GenerationParams | null;
  },
  resolved: ResolvedGateway | null
): GenerationQuote {
  return quoteGeneration(
    {
      model: request.model ?? "",
      resolution: request.params?.resolution,
      aspectRatio: request.params?.aspectRatio,
      duration: request.params?.duration,
      prompt: request.prompt ?? ""
    },
    resolved?.source === "system"
  );
}

/**
 * Refuses a generation nobody can pay for, before there is anything to show for
 * it.
 *
 * Advisory, and deliberately early rather than authoritative: the real debit
 * happens in `runGeneration`, under a conditional update that two concurrent
 * generations cannot both win. What this buys is the ordinary case — the caller
 * finds out at the moment it presses the button, instead of watching a node
 * appear on everyone's canvas and then turn grey.
 */
async function assertAffordable(organizationId: string, quote: GenerationQuote) {
  if (!quote.billable) return;

  const { balance } = await readBalance(organizationId);

  if (balance >= quote.total) return;

  throw new Error(INSUFFICIENT_CREDITS_MESSAGE);
}

const startInput = z.object({
  projectId: canonicalId,
  modality: z.enum(ASSET_KINDS),
  prompt: z.string().trim().min(1).max(10_000),
  model: z.string().min(1).max(200),
  resolution: z.string().max(50).optional(),
  aspectRatio: z.string().max(50).optional(),
  duration: z.number().positive().max(600).optional(),
  /** Files the composer's `@` attached, on their way to the reference table. */
  referenceAssetIds: z.array(canonicalId).max(8).default([])
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

    // Before the row, so a generation nobody can pay for leaves nothing behind
    // to sweep up — and against the *organization's* wallet, because a
    // generation is work done inside a tenant and the bill belongs where its
    // project, canvas and assets already do. `access.organizationId` is both
    // the organization the session is scoped to and the one this project lives
    // in; `getProjectAccess` only answers when those two agree.
    await assertAffordable(
      access.organizationId,
      quoteFor(
        { model: data.model, prompt: data.prompt, params },
        await resolveGateway(access.organizationId)
      )
    );

    // The object key embeds the asset id and is NOT NULL from the first
    // insert, so the id is fetched ahead of the row — see `newRowId`.
    const assetId = await newRowId(db);
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

/**
 * The inputs this generation was started with, as links a vendor can fetch.
 *
 * Read back from `asset_reference` rather than accepted on this second call:
 * the lineage was validated and written when the generation was created, so
 * re-sending it here would be a second chance to name a file the first check
 * refused. The join re-applies the same conditions anyway — same organization,
 * ready, undeleted — because a referenced asset can be deleted between the two
 * calls, and a link to a tombstoned file is not one to hand a third party.
 */
async function loadReferences(
  db: ReturnType<typeof getDB>,
  assetId: string,
  organizationId: string
): Promise<GenerationReference[]> {
  const rows = await db
    .select({
      id: schema.asset.id,
      kind: schema.asset.kind,
      mimeType: schema.asset.mimeType,
      filename: schema.asset.filename,
      objectKey: schema.asset.objectKey,
      role: schema.assetReference.role
    })
    .from(schema.assetReference)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.assetReference.referencedAssetId))
    .where(
      and(
        eq(schema.assetReference.assetId, assetId),
        eq(schema.asset.organizationId, organizationId),
        eq(schema.asset.status, "ready"),
        isNull(schema.asset.deletedAt)
      )
    )
    .orderBy(schema.assetReference.position);

  // Minted one at a time rather than in a batch because signing is local
  // work — no network, no rate limit — so there is nothing to amortize.
  return Promise.all(
    rows.map(async (row) => ({
      url: await assetDownloadUrl(row),
      // The row's own type, not the allowlist's verdict: a provider is told
      // what the bytes are, while the URL itself already refuses to serve an
      // unvetted type as anything but an opaque download.
      mimeType: row.mimeType ?? "application/octet-stream",
      kind: row.kind,
      role: row.role
    }))
  );
}

/**
 * The bytes into the bucket, retried where retrying is free.
 *
 * By this point the expensive half is done — the provider has answered — so
 * losing the whole generation to one bad moment on the way to R2 is the worst
 * trade in the pipeline. But a repeat is only safe because it is
 * indistinguishable from the first attempt: same key, same bytes, same type,
 * and the row is not touched until the bytes are in.
 *
 * Which is exactly why a sized stream gets one attempt and no more. It is
 * consumed by the attempt that failed, and there is nothing left to send
 * again. Buffering it to make it retriable is not a trade to make quietly
 * either — an unbounded video would be held whole in the isolate's memory to
 * buy that retry. A stream of *unknown* length is already read whole before
 * R2 will accept it, so that one gets its retries for free.
 */
async function putGeneratedBytes(objectKey: string, result: GenerationResult, contentType: string) {
  const options = { httpMetadata: { contentType } };

  let body = result.body;

  if (body instanceof ReadableStream) {
    const length = result.contentLength;

    if (length === undefined) {
      body = await new Response(body).arrayBuffer();
    } else {
      // R2 refuses a stream it cannot size, so it rides through a
      // FixedLengthStream sized by the provider's declared length; a pipe
      // failure surfaces through the put, not as an unhandled rejection.
      const fixed = new FixedLengthStream(length);

      void body.pipeTo(fixed.writable).catch(() => {});

      return env.MEDIA.put(objectKey, fixed.readable, options);
    }
  }

  return withRetry(
    () => env.MEDIA.put(objectKey, body as ArrayBuffer, options),
    // Everything that can still fail here is transport. The key, the type and
    // the length were all settled before the first attempt, so a repeat meets
    // either the same weather or better — there is no request to fix.
    () => true
  );
}

/**
 * Marks a generation failed, without letting that write become the failure.
 *
 * Guarded on pending-and-undeleted for the same reason the bind is: a row
 * deleted while the model worked is not this call's to rewrite. If even this is
 * lost the row stays pending, and the stale-pending sweep resolves it after the
 * grace period.
 */
async function failAsset(db: ReturnType<typeof getDB>, assetId: string, reason: string) {
  await db
    .update(schema.asset)
    .set({ status: "failed", error: reason })
    .where(
      and(
        eq(schema.asset.id, assetId),
        eq(schema.asset.status, "pending"),
        isNull(schema.asset.deletedAt)
      )
    )
    .catch(() => {});
}

const runInput = z.object({ assetId: canonicalId });

export const runGeneration = createServerFn({ method: "POST" })
  .validator(runInput)
  .handler(
    async ({ data }): Promise<{ assetId: string; mimeType: string; title: string | null }> => {
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

      // The claim, before a single byte is written. Two concurrent runs for the
      // same row would PUT the same object key twice, and whichever bind lost
      // would leave the row's recorded ETag pointing at bytes the other run
      // replaced — a ready asset the serving route can only ever 404. "Never
      // claimed" is `updated_at = created_at`: the insert writes both from the
      // same transaction-stable now(), and nothing else touches a pending AI
      // row, so the first claim moves `updated_at` and every later one finds
      // zero rows and stops here, before its PUT can clobber the winner's.
      const claimed = await db
        .update(schema.asset)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(schema.asset.id, asset.id),
            eq(schema.asset.status, "pending"),
            isNull(schema.asset.deletedAt),
            eq(schema.asset.updatedAt, schema.asset.createdAt)
          )
        )
        .returning({ id: schema.asset.id });

      if (claimed.length === 0) {
        throw new Error("That asset is not waiting to be generated.");
      }

      /**
       * The money, taken between the claim and the first byte leaving this
       * Worker.
       *
       * After the claim, so only the run that won it can charge — otherwise two
       * clients racing the same row would both debit and only one would produce
       * a file. Before the provider, because a wallet that is checked after the
       * work is not a limit: a caller with one yuan could fire fifty
       * generations, each of which would find a positive balance on the way in
       * and a bill on the way out.
       *
       * `referenceId` is the asset id, and the ledger's unique index over
       * (kind, reference) is what makes that true forever — a replayed call
       * cannot charge this asset twice. A retry is charged again because
       * `retryGeneration` creates a *new* row with a new id, which is exactly
       * right: it is a second generation.
       */
      // Resolved once, here, and handed to everything below: the media call,
      // the naming call and the price all have to agree about whose key this
      // generation is going out on.
      const resolved = await resolveGateway(asset.organizationId);
      const quote = quoteFor(asset, resolved);
      let charge: LedgerEntry | null = null;

      if (quote.billable) {
        try {
          charge = await debit({
            organizationId: asset.organizationId,
            // Recorded so the organization's statement can say who spent it.
            // Attribution, never authorization — what may be spent was settled
            // by the organization id above.
            userId,
            kind: "usage",
            amount: quote.total,
            referenceId: asset.id,
            description: `${asset.kind} · ${findModel(asset.model ?? "")?.name ?? asset.model}`,
            metadata: {
              model: asset.model,
              modality: asset.kind,
              unit: quote.unit,
              quantity: quote.quantity,
              modelShare: quote.model,
              namingFee: quote.naming
            }
          });
        } catch (error) {
          if (!(error instanceof InsufficientCredits)) throw error;

          await failAsset(db, asset.id, INSUFFICIENT_CREDITS_MESSAGE);

          throw new Error(INSUFFICIENT_CREDITS_MESSAGE);
        }
      }

      /** Where every meter row for this generation gets its common fields. */
      const meterContext = {
        organizationId: asset.organizationId,
        userId,
        projectId: asset.projectId,
        assetId: asset.id,
        transactionId: charge?.transactionId ?? null,
        // Recorded even when nothing was charged, which is the whole point:
        // an organization on its own key still wants to know what it ran.
        keySource: resolved?.source ?? "system"
      };

      // Declared out here so the failure path can still meter the naming call
      // without waiting for it — see the catch.
      let naming: ReturnType<typeof generateAssetTitle> | null = null;
      let stored;

      try {
        // After the claim, so a run that lost the race never mints links to the
        // winner's inputs, and as late as possible before the provider call, so
        // the short TTL is spent on the fetch rather than on the queue ahead of
        // it.
        const references = await loadReferences(db, asset.id, asset.organizationId);

        // Named in parallel with the work, not after it: the provider is the
        // slow half, so naming costs nothing as long as it runs alongside. It
        // resolves rather than throwing, so a failed naming call cannot take
        // the generation down with it.
        naming = generateAssetTitle(asset.prompt ?? "", resolved?.gateway ?? null);

        const result = await getProvider(asset.model ?? "", resolved).run(
          {
            modality: asset.kind,
            prompt: asset.prompt ?? "",
            model: asset.model ?? "",
            resolution: asset.params?.resolution,
            aspectRatio: asset.params?.aspectRatio,
            duration: asset.params?.duration,
            references
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
        const contentType = normalizeMime(result.contentType);

        if (!ALLOWED_MIME[asset.kind].includes(contentType)) {
          throw new Error(`Provider answered with an unsupported ${asset.kind} type.`);
        }

        const object = await putGeneratedBytes(asset.objectKey, result, contentType);
        const named = await naming;

        // Metered here rather than the moment each call returned, because what
        // goes in `chargedAmount` is what the wallet *keeps* — and until the
        // bytes are safely in R2 this generation could still fail and be
        // refunded. Recording the split only on the path where the charge
        // survives is what makes `sum(chargedAmount)` over an asset's events
        // equal the ledger entry that paid for it.
        await recordUsageEvent({
          ...meterContext,
          purpose: "generation",
          modality: asset.kind,
          model: asset.model ?? "",
          status: "succeeded",
          unit: quote.unit,
          quantity: quote.quantity,
          chargedAmount: quote.model,
          call: result.call
        });

        if (named.call) {
          await recordUsageEvent({
            ...meterContext,
            purpose: "title",
            model: TITLE_MODEL,
            status: named.error ? "failed" : "succeeded",
            error: named.error,
            chargedAmount: quote.naming,
            call: named.call
          });
        }

        stored = { object, contentType, title: named.title };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Generation failed.";

        // Best effort, and guarded like the bind below: a row deleted while
        // the model worked is not this call's to rewrite. If even this is
        // lost, the row stays pending and the stale-pending sweep resolves it.
        await failAsset(db, asset.id, reason);

        // Nothing was produced, so nothing is owed. Idempotent by the same
        // unique index the charge uses, and it reads the amount off the charge
        // rather than re-quoting — a refund that does not match its own charge
        // would silently mint or destroy credit.
        if (charge) {
          await refundCharge(
            asset.organizationId,
            asset.id,
            "Refund · generation failed",
            userId
          ).catch((refundError: unknown) => {
            // Loud, because this is the one failure here that costs somebody
            // money: the generation is already marked failed, so nothing
            // downstream will try again.
            console.error(`failed to refund generation ${asset.id}`, refundError);
          });
        }

        // Charged nothing in the end, so the meter says so — the calls still
        // happened and still cost us, which is the difference this table is
        // here to show.
        await recordUsageEvent({
          ...meterContext,
          purpose: "generation",
          modality: asset.kind,
          model: asset.model ?? "",
          status: "failed",
          error: reason,
          unit: quote.unit,
          quantity: quote.quantity,
          chargedAmount: 0
        });

        // Not awaited — naming has a 20 second patience of its own, and a
        // generation that has already failed should not be held open for it —
        // but handed to `waitUntil` rather than merely started, because an
        // isolate that has answered is free to stop running and the row would
        // land only sometimes.
        if (naming) {
          meterInBackground(
            naming.then((named) => {
              if (!named.call) return;

              return recordUsageEvent({
                ...meterContext,
                purpose: "title",
                model: TITLE_MODEL,
                status: named.error ? "failed" : "succeeded",
                error: named.error,
                chargedAmount: 0,
                call: named.call
              });
            })
          );
        }

        // The one reason worth repeating to the caller: it is the only failure
        // here that the person can do something about, and the canvas has no
        // other channel for a message. Everything else stays generic, and the
        // real reason is on the row.
        throw new Error(reason === INSUFFICIENT_CREDITS_MESSAGE ? reason : "Generation failed.");
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
          etag: stored.object.etag,
          // Left null when the naming call failed; every reader falls back
          // through `assetTitle` rather than showing an empty name.
          title: stored.title
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
        // The bytes are left where they are. With the claim above, a miss can
        // only mean the row was deleted while the model worked; the object is
        // still reachable from the row's own `objectKey`, which the tombstone
        // sweep collects. Deleting it here would still be a live race against
        // `deleteAsset`'s own R2 delete, for no storage the sweep won't get.
        //
        // The charge stands, and not by oversight: the model ran, the vendor
        // billed us, and the only way to get here is somebody deleting their
        // own node while it was working. Refunding that would make "delete the
        // node the instant it finishes" a way to generate for free.
        throw new Error("That asset no longer exists.");
      }

      // No URL: the caller looks one up by id, from the assets query, because a
      // link to these bytes is presigned and expires — handing one back here
      // would invite it into the collaborative document, which is forever.
      return {
        assetId: asset.id,
        // The serving URL's extension is decoration; a player that routes by
        // source type still needs told what is behind the link.
        mimeType: stored.contentType,
        title: stored.title
      };
    }
  );

const retryInput = z.object({ assetId: canonicalId });

/**
 * A second attempt at a generation that failed, as a new row.
 *
 * The old row cannot simply be run again. `runGeneration` claims a row by
 * moving `updated_at` off `created_at`, and that claim is spent the moment the
 * first attempt starts — there is no way back to "never claimed" that another
 * client could not forge, and re-opening one would mean a failed generation
 * could be re-run by anyone who kept the id. A fresh row also gets a fresh
 * object key, so the retry cannot collide with bytes the previous attempt may
 * have half-written.
 *
 * The parameters come off the failed row rather than from the caller, and that
 * is the point of doing this server-side at all: `resolution`, `duration` and
 * the reference list were never written into the canvas document, so a client
 * asked to re-submit them could only guess. Taking them from the row makes the
 * retry the *same* request, not a similar one.
 *
 * The old row is tombstoned rather than left alone: it holds no bytes, nothing
 * points at it once the node moves to the new id, and the sweep already knows
 * how to collect a tombstone. What survives it is the reason it failed, until
 * the sweep gets there.
 */
export const retryGeneration = createServerFn({ method: "POST" })
  .validator(retryInput)
  .handler(async ({ data }): Promise<{ assetId: string }> => {
    const access = await requireAssetAccess(getRequest().headers, data.assetId);

    if (!access) throw new Error("That asset no longer exists.");

    const { asset, userId } = access;

    // Only the person who asked for it, and only something that actually
    // failed: a pending row is either still running or about to be resolved by
    // the sweep, and a ready one has nothing to retry.
    if (asset.source !== "ai" || asset.status !== "failed" || asset.createdBy !== userId) {
      throw new Error("That generation cannot be retried.");
    }

    // Nullable because an asset outlives its project — and a generation with
    // nowhere to land is not one to start.
    if (!asset.projectId) throw new Error("That project no longer exists.");

    const db = getDB();

    // Re-read rather than re-validate what the first attempt validated: an
    // input can be deleted between the two attempts, and silently generating
    // from fewer references than were asked for would answer a question
    // nobody put. Position order is preserved so the retry feeds the provider
    // the same list in the same order.
    const references = await db
      .select({
        referencedAssetId: schema.assetReference.referencedAssetId,
        position: schema.assetReference.position,
        stillUsable: schema.asset.id
      })
      .from(schema.assetReference)
      .leftJoin(
        schema.asset,
        and(
          eq(schema.asset.id, schema.assetReference.referencedAssetId),
          eq(schema.asset.organizationId, asset.organizationId),
          eq(schema.asset.status, "ready"),
          isNull(schema.asset.deletedAt)
        )
      )
      .where(eq(schema.assetReference.assetId, asset.id))
      .orderBy(schema.assetReference.position);

    if (references.some((row) => row.stillUsable === null)) {
      throw new Error("A referenced asset no longer exists.");
    }

    // A retry is a second generation and is charged like one — the failed
    // attempt was refunded, and this one gets its own row, its own id and its
    // own debit. Checked here so an empty wallet is told before the old node is
    // tombstoned, which would otherwise trade a failed generation the person
    // can still see for one they cannot.
    await assertAffordable(
      asset.organizationId,
      quoteFor(asset, await resolveGateway(asset.organizationId))
    );

    const assetId = await newRowId(db);
    const objectKey = `${asset.organizationId}/${asset.projectId}/${assetId}`;

    await db.transaction(async (tx) => {
      await tx.insert(schema.asset).values({
        id: assetId,
        organizationId: asset.organizationId,
        projectId: asset.projectId,
        source: "ai",
        kind: asset.kind,
        status: "pending",
        objectKey,
        prompt: asset.prompt,
        model: asset.model,
        params: asset.params,
        createdBy: userId
      });

      if (references.length > 0) {
        await tx.insert(schema.assetReference).values(
          references.map((row) => ({
            assetId,
            referencedAssetId: row.referencedAssetId,
            position: row.position
          }))
        );
      }

      // Guarded on the state this handler decided against, so two retries
      // fired at once cannot both believe they replaced the same attempt —
      // the loser's insert is rolled back with it.
      const replaced = await tx
        .update(schema.asset)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(schema.asset.id, asset.id),
            eq(schema.asset.status, "failed"),
            isNull(schema.asset.deletedAt)
          )
        )
        .returning({ id: schema.asset.id });

      if (replaced.length === 0) throw new Error("That generation cannot be retried.");
    });

    return { assetId };
  });
