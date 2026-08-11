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
    maxUses: 1
  });

  return drizzle({ client: pool, schema });
}

const dbCache = new WeakMap<Request, ReturnType<typeof createDB>>();

export function getDB() {
  let request: Request;
  try {
    request = getRequest();
  } catch {
    return createDB();
  }

  const cached = dbCache.get(request);
  if (cached !== undefined) return cached;

  const created = createDB();
  dbCache.set(request, created);

  return created;
}
