import { env } from "cloudflare:workers";
import { and, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { getDB, schema } from "#/db";

/**
 * The other half of every write path in the asset layer.
 *
 * Rows are always created before their bytes and tombstoned before their
 * bytes are deleted, which is what guarantees the bucket never holds an
 * object no row names. The cost of that guarantee is the reverse: rows whose
 * objects still need collecting. This is what collects them.
 *
 * Three kinds of row qualify, and the shape of the work is identical for all
 * three — delete the object, then delete the row:
 *
 *   - tombstoned (`deletedAt` set), where the user-facing delete already
 *     removed the asset from sight and the object delete may have been lost;
 *   - `pending` past any plausible transfer, which is an upload that was
 *     started and abandoned, or a generation whose worker died. Their bytes
 *     may or may not exist; `delete` is indifferent;
 *   - `failed`, which includes uploads rejected for size after the object
 *     had already landed.
 *
 * Nothing here touches a `ready` row: those are the live assets.
 *
 * It is also the shape organization teardown will take, whenever the app
 * grows that action — the `restrict` on `asset.organizationId` demands the
 * rows go first, and the answer is to tombstone them and let this drain them,
 * never to cascade rows away and strand every object they named.
 */

/**
 * How long a row must have sat before it is collected. Generous against the
 * slowest legitimate upload — the presigned URL it would be using expires in
 * five minutes — and against a clock skew between the worker and Postgres.
 * A tombstoned row waits the same period, so a delete that raced a read does
 * not pull the bytes out from under it.
 */
const GRACE_HOURS = 24;

/** Bounded so one run cannot outlive its invocation on a large backlog. */
const BATCH = 200;

export interface SweepResult {
  collected: number;
  failures: number;
}

export async function sweepAssets(): Promise<SweepResult> {
  const db = getDB();
  const cutoff = sql`now() - interval '${sql.raw(String(GRACE_HOURS))} hours'`;

  const stale = await db
    .select({ id: schema.asset.id, objectKey: schema.asset.objectKey })
    .from(schema.asset)
    .where(
      or(
        and(isNotNull(schema.asset.deletedAt), lt(schema.asset.deletedAt, cutoff)),
        and(
          isNull(schema.asset.deletedAt),
          inArray(schema.asset.status, ["pending", "failed"]),
          lt(schema.asset.updatedAt, cutoff)
        )
      )
    )
    .limit(BATCH);

  if (stale.length === 0) return { collected: 0, failures: 0 };

  const collected: string[] = [];
  let failures = 0;

  // Object first, row second — the opposite of the live delete path, and for
  // the same reason it is safe here: the row is already invisible to serving,
  // so the only thing its survival costs is another attempt next run. Losing
  // the row while the object stood would cost the key forever.
  for (const row of stale) {
    try {
      await env.MEDIA.delete(row.objectKey);
      collected.push(row.id);
    } catch (error) {
      failures += 1;
      console.error(`sweep: could not delete ${row.objectKey}`, error);
    }
  }

  if (collected.length > 0) {
    // Re-checked in the delete itself: a row that became `ready` between the
    // select and now is one a generation just bound, and it is no longer the
    // sweep's to remove. Its object is gone, which the guarded bind in
    // `runGeneration` cannot happen after — that bind requires `pending`.
    await db
      .delete(schema.asset)
      .where(
        and(
          inArray(schema.asset.id, collected),
          or(isNotNull(schema.asset.deletedAt), sql`${schema.asset.status} <> 'ready'`)
        )
      );
  }

  return { collected: collected.length, failures };
}
