import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
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
