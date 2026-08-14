import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: [".env.local", ".env"] });

/**
 * Schema changes go through generated migrations in `./drizzle` — `db:generate`
 * writes one, `db:migrate` applies it, and `__drizzle_migrations` records what
 * a database has already seen.
 *
 * There is deliberately no `db:push` alongside this. `push` diffs the schema
 * straight against a database and applies the result without writing anything
 * down, so a pushed change is invisible to the migration history: the next
 * `generate` still emits it (the schema files are all it reads), and `migrate`
 * then runs a `CREATE`/`ADD` for an object that is already there and fails.
 * The two are alternatives, not a fast path and a careful path.
 *
 * `DATABASE_URL` is a *direct* connection, which is why it exists separately
 * from the app's own: the running app reaches Postgres through Hyperdrive, and
 * `drizzle-kit` needs to speak to the database itself. Production migrations
 * are run from here too, by pointing this at the production database — a
 * Worker cannot run them, having no filesystem to read the SQL from.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL
  }
});
