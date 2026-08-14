import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export { schema };

function createDB() {
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    max: 5,
    maxUses: 1,
    // A connect that hangs instead of failing would otherwise hold its slot
    // forever — five of those and every later caller queues behind them with
    // no timeout of its own. Bounding the acquire turns a black-hole outage
    // into ordinary errors, which the callers already handle.
    connectionTimeoutMillis: 10_000
  });

  return drizzle({ client: pool, schema });
}

const dbCache = new WeakMap<Request, ReturnType<typeof createDB>>();

/**
 * The pool for callers with no request to key on — Durable Object alarms, the
 * cron sweep, and `auth`'s module-scope adapter. One per isolate rather than
 * one per call: `maxUses: 1` already gives every query a fresh Hyperdrive
 * connection and closes it after, so nothing here goes stale, and minting a
 * new `Pool` object per alarm tick was pure allocation — none of them were
 * ever `end()`ed.
 */
let fallbackDB: ReturnType<typeof createDB> | undefined;

export function getDB() {
  let request: Request;
  try {
    request = getRequest();
  } catch {
    fallbackDB ??= createDB();

    return fallbackDB;
  }

  const cached = dbCache.get(request);
  if (cached !== undefined) return cached;

  const created = createDB();
  dbCache.set(request, created);

  return created;
}

/**
 * An id fetched a round trip ahead of the row it belongs to.
 *
 * For the writes whose own insert needs the id — an asset's object key embeds
 * it and is NOT NULL from the first insert — so the column default is too
 * late. Minted by the same `uuidv7()` that default calls, which is what keeps
 * these ids sortable like every other row's rather than a v4 from the isolate.
 */
export async function newRowId(db: ReturnType<typeof getDB>): Promise<string> {
  const generated = (await db.execute(sql`select uuidv7() as id`)) as unknown as {
    rows: Array<{ id: string }>;
  };

  return generated.rows[0].id;
}
