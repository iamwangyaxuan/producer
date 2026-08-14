import { eq } from "drizzle-orm";
import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

import { getDB, schema } from "#/db";
import { canAccessProjectCanvas } from "#/server/canvas-access";

/**
 * How often the room re-asks whether everyone connected is still allowed to
 * be. The gate at the door only runs once, at connect time, but sockets live
 * for days — someone removed from the organization, or a project archived
 * under them, must not keep a live feed of everything drawn afterwards. Five
 * minutes bounds how long revoked access lingers, at the cost of waking the
 * room that often while anyone is in it.
 */
const REVALIDATE_MS = 5 * 60 * 1000;

/**
 * Chunk size for the local fallback buffer. A SQLite value in Durable Object
 * storage caps out at 2 MB, and a buffered snapshot that crossed it would make
 * the fallback throw — which is the one place that must not fail, since it only
 * runs when the database has already refused. Splitting rows removes the cliff.
 * (Postgres has no equivalent limit, so the authoritative copy is one row.)
 */
const SNAPSHOT_CHUNK_BYTES = 1_000_000;

/**
 * How many *consecutive* alarm rounds may fail to reach the database before
 * fail-open flips to fail-closed. One blip must not kick a whole room — that
 * is the fail-open below — but an outage that outlives three rounds is a
 * quarter of an hour during which a revoked member keeps a live feed, and at
 * some point "we cannot verify anyone" has to mean "nobody stays". The
 * counter lives in storage, not on the instance: hibernation would otherwise
 * reset it every round and the ceiling would never be reached.
 */
const MAX_REVALIDATE_FAILURES = 3;

const FAILURE_COUNT_KEY = "revalidate_failures";
const REVALIDATE_AT_KEY = "revalidate_at";
const RETRY_AT_KEY = "snapshot_retry_at";
const RETRY_DELAY_KEY = "snapshot_retry_delay";

/**
 * Backoff for re-pushing a snapshot the database refused. Starts short because
 * most failures are a single timed-out connection, and caps at the revalidation
 * period so a genuinely down database costs one wake per five minutes rather
 * than a spin — and so a canvas lands at most that long after Postgres returns.
 */
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = REVALIDATE_MS;

/**
 * Postgres `foreign_key_violation`. The only way a snapshot write hits one is
 * that the project row is gone, which no amount of retrying will bring back —
 * see `saveNow`, where it is the single failure that gives up instead.
 */
const FOREIGN_KEY_VIOLATION = "23503";

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === FOREIGN_KEY_VIOLATION
  );
}

/** What each connection remembers about who opened it. ≤2 KB, per the platform. */
interface ConnectionAuth {
  cookie: string;
}

/**
 * One Durable Object per project canvas, named by the project id.
 *
 * y-partyserver runs the whole Yjs wire protocol — sync on connect, update
 * relay, awareness for cursors and presence — so what is owned here is
 * durability and tenancy: the document is loaded from Postgres when the room
 * wakes, written back on y-partyserver's debounced save, and every connection
 * is periodically re-checked against the same membership rules that guard the
 * project's HTTP reads.
 *
 * Postgres holds the document so that one database holds everything the app
 * owns (see `canvasSnapshot` in the schema). This object's own SQLite is kept
 * as a write buffer for the times Postgres cannot be reached: y-partyserver
 * swallows a failing `onSave` with nothing but a `console.error`, so without a
 * local landing place a database blip would silently discard however much
 * work the room had accumulated. Steady state leaves that buffer empty.
 */
export class CanvasRoom extends YServer {
  /**
   * Hibernation keeps an idle room from being billed as a running one: open
   * sockets survive eviction and the document is rebuilt from storage on the
   * next message. Supported by y-partyserver since 2.1.0, which moved its
   * awareness bookkeeping into the sockets themselves for exactly this.
   */
  static options = { hibernate: true };

  /**
   * Set by `purge()` so an `onAlarm` that was suspended across it — the input
   * gate opens during the database await, which is exactly where the RPC can
   * slot in — does not re-arm the alarm or write storage that was just wiped.
   */
  private purged = false;

  /**
   * Saves run one at a time and always encode the document as it is *now*.
   * The debounced save and the retry alarm can both fire into the same room,
   * and two overlapping writes would race to be the last one Postgres keeps —
   * with no guarantee the winner is the newer. Serialized, each write is a
   * fresh full encode, so the last one to land is by construction the most
   * recent state. It also means a retry never carries a stale payload: the
   * document in memory has already absorbed everything the buffer held.
   */
  private saveChain: Promise<void> = Promise.resolve();

  async onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS snapshot_buffer (seq INTEGER PRIMARY KEY, content BLOB NOT NULL, saved_at INTEGER NOT NULL)"
    );

    // YServer's own onStart is what wires sync, awareness and persistence up;
    // skipping it would leave a room that accepts connections and says nothing.
    return super.onStart();
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    // The cookie is the connection's identity for as long as it lives — the
    // revalidation alarm below replays it against the access check, because a
    // hibernated socket is all that remains of the request that opened it.
    // Merged rather than assigned: y-partyserver keeps its own bookkeeping in
    // this same connection state, and neither side may blank the other's.
    connection.setState((previous: unknown) => ({
      ...(previous as Record<string, unknown> | null),
      cookie: ctx.request.headers.get("cookie") ?? ""
    }));

    if ((await this.ctx.storage.get<number>(REVALIDATE_AT_KEY)) === undefined) {
      await this.ctx.storage.put(REVALIDATE_AT_KEY, Date.now() + REVALIDATE_MS);
    }

    await this.rearm();

    return super.onConnect(connection, ctx);
  }

  /**
   * The alarm serves two schedules — re-checking access, and re-pushing a
   * snapshot Postgres refused — because a Durable Object has exactly one. Each
   * keeps its own due time in storage; whichever is due runs, and the next
   * alarm is set to the earlier of the two that remain.
   */
  async onAlarm() {
    const now = Date.now();

    const retryAt = await this.ctx.storage.get<number>(RETRY_AT_KEY);
    const revalidateAt = await this.ctx.storage.get<number>(REVALIDATE_AT_KEY);

    if (retryAt !== undefined && now >= retryAt) await this.enqueueSave();
    if (revalidateAt !== undefined && now >= revalidateAt) await this.revalidate();

    // Everything above awaited network I/O, so the input gate was open and a
    // `purge()` may have run in between — its wipe must be the last word.
    if (this.purged) return;

    await this.rearm();
  }

  /**
   * The standing half of the door check: connections whose session no longer
   * passes — signed out everywhere, removed from the organization, project
   * archived — are closed, and the client's reconnect attempt runs into the
   * worker's `onBeforeConnect` gate, which now refuses it.
   */
  private async revalidate() {
    let connections = 0;
    let errored = false;

    const unverified: Connection[] = [];

    for (const connection of this.getConnections<ConnectionAuth>()) {
      connections++;

      const headers = new Headers({ cookie: connection.state?.cookie ?? "" });

      let allowed = false;

      try {
        allowed = await canAccessProjectCanvas(headers, this.name);
      } catch (error) {
        // The database being unreachable is not evidence anyone's access was
        // revoked; keeping the room alive is the conservative answer — for a
        // while. The rounds counter below is what keeps "a while" finite.
        console.error("canvas access revalidation failed:", error);
        errored = true;
        allowed = true;
        unverified.push(connection);
      }

      if (!allowed) connection.close(4001, "Access revoked");
    }

    if (this.purged) return;

    if (connections === 0) {
      // The final round of an occupancy: with nobody left there is nothing to
      // re-check, so this schedule stops. A count left behind would greet the
      // next occupancy as if its failures belonged to this one — "three
      // *consecutive* rounds" would quietly become "three errors ever, weeks
      // apart". The next session starts from zero.
      await this.ctx.storage.delete([FAILURE_COUNT_KEY, REVALIDATE_AT_KEY]);

      return;
    }

    if (errored) {
      const failures = ((await this.ctx.storage.get<number>(FAILURE_COUNT_KEY)) ?? 0) + 1;

      if (failures >= MAX_REVALIDATE_FAILURES) {
        // Fail closed: nobody here has been verifiable for three rounds.
        // Clients will retry, and the worker's `onBeforeConnect` gate needs
        // the same database — so they stay out exactly as long as the outage
        // lasts, and walk straight back in when it ends.
        for (const connection of unverified) {
          connection.close(4002, "Access could not be verified");
        }
        await this.ctx.storage.put(FAILURE_COUNT_KEY, 0);
      } else {
        await this.ctx.storage.put(FAILURE_COUNT_KEY, failures);
      }
    } else if (((await this.ctx.storage.get<number>(FAILURE_COUNT_KEY)) ?? 0) !== 0) {
      // Reset only when there is something to reset — this runs every five
      // minutes in every occupied room, and a healthy round should not cost
      // a storage write.
      await this.ctx.storage.put(FAILURE_COUNT_KEY, 0);
    }

    await this.ctx.storage.put(REVALIDATE_AT_KEY, Date.now() + REVALIDATE_MS);
  }

  /** The alarm for whichever schedule is due first, or none if neither is armed. */
  private async rearm() {
    const retryAt = await this.ctx.storage.get<number>(RETRY_AT_KEY);
    const revalidateAt = await this.ctx.storage.get<number>(REVALIDATE_AT_KEY);

    const due = [retryAt, revalidateAt].filter((at): at is number => at !== undefined);

    if (due.length === 0) {
      await this.ctx.storage.deleteAlarm();

      return;
    }

    await this.ctx.storage.setAlarm(Math.min(...due));
  }

  /**
   * Called over RPC when the project itself is deleted. The snapshot row goes
   * with the project by way of its foreign key, so what is left here is this
   * object's own state: connections, the alarm, and any buffered write — which
   * must go, because the project row it referenced no longer exists and no
   * retry of it could ever be accepted.
   */
  async purge() {
    this.purged = true;

    for (const connection of this.getConnections()) {
      connection.close(4001, "Project deleted");
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async onLoad() {
    const buffered = this.readBuffer();

    if (buffered) {
      // The buffer is a whole document, not a delta — every save is a full
      // encode — and by definition newer than Postgres, which is why it is
      // there. Loading it needs no database at all, which is the point: the
      // room comes back during the outage that created the buffer.
      Y.applyUpdate(this.document, buffered);

      // A fresh short wait rather than wherever the backoff had climbed to
      // before the room went down: this is a new attempt at a database that
      // has had time to come back, not the next one in a losing streak.
      await this.armRetry(RETRY_BASE_MS);

      return;
    }

    // Deliberately unguarded. A read that fails here must take the room down
    // with it: starting empty would look like a blank canvas, and the first
    // save after that would overwrite the real document with nothing. A
    // thrown error fails the connection instead, and the client reconnects.
    const rows = await getDB()
      .select({ content: schema.canvasSnapshot.content })
      .from(schema.canvasSnapshot)
      .where(eq(schema.canvasSnapshot.projectId, this.name))
      .limit(1);

    if (rows.length === 0) return;

    Y.applyUpdate(this.document, rows[0].content);
  }

  async onSave() {
    return this.enqueueSave();
  }

  /** Serializes saves onto one chain — see `saveChain` for why that matters. */
  private enqueueSave(): Promise<void> {
    this.saveChain = this.saveChain
      .then(() => this.saveNow())
      .catch((error) => {
        // The chain has to stay settled-not-rejected: a rejection left in it
        // would make every later `.then` skip its callback, and the room would
        // stop saving for the rest of its life without saying so. `saveNow`
        // already handles the failures it expects; this is the unforeseen one.
        console.error("canvas snapshot save failed:", error);
      });

    return this.saveChain;
  }

  private async saveNow() {
    if (this.purged) return;

    // A full snapshot every time rather than an update log: re-encoding also
    // garbage-collects everything deleted, so the stored document stays the
    // size of what is on the canvas, not the size of its history.
    const update = Y.encodeStateAsUpdate(this.document);

    try {
      await getDB()
        .insert(schema.canvasSnapshot)
        .values({ projectId: this.name, content: update })
        .onConflictDoUpdate({
          target: schema.canvasSnapshot.projectId,
          set: { content: update, savedAt: new Date() }
        });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        // The project was deleted out from under a room that was still
        // saving. Nothing to keep and nothing to retry.
        this.clearBuffer();
        await this.ctx.storage.delete([RETRY_AT_KEY, RETRY_DELAY_KEY]);

        return;
      }

      console.error("failed to persist canvas snapshot:", error);
      this.writeBuffer(update);
      await this.armRetry();

      return;
    }

    // Only now is Postgres the newer copy, and the local one redundant.
    this.clearBuffer();
    await this.ctx.storage.delete([RETRY_AT_KEY, RETRY_DELAY_KEY]);
  }

  /**
   * Arms the retry schedule, doubling the wait each consecutive failure.
   * `delay` overrides it for the load path, where the buffer is already known
   * to be behind and there is no failure yet to back off from.
   */
  private async armRetry(delay?: number) {
    let next = delay;

    if (next === undefined) {
      const previous = await this.ctx.storage.get<number>(RETRY_DELAY_KEY);

      next = previous === undefined ? RETRY_BASE_MS : Math.min(previous * 2, RETRY_MAX_MS);
    }

    await this.ctx.storage.put(RETRY_DELAY_KEY, next);
    await this.ctx.storage.put(RETRY_AT_KEY, Date.now() + next);
    await this.rearm();
  }

  /** The last update Postgres refused, or null when it owes nothing. */
  private readBuffer(): Uint8Array | null {
    const rows = this.ctx.storage.sql
      .exec("SELECT content FROM snapshot_buffer ORDER BY seq")
      .toArray();

    if (rows.length === 0) return null;

    const chunks = rows.map((row) =>
      row.content instanceof ArrayBuffer ? new Uint8Array(row.content) : new Uint8Array(0)
    );
    const update = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));

    let offset = 0;

    for (const chunk of chunks) {
      update.set(chunk, offset);
      offset += chunk.length;
    }

    return update;
  }

  private writeBuffer(update: Uint8Array) {
    // Replace-all inside one transaction, so a crash between the delete and
    // the last insert cannot leave half a snapshot to be restored from.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM snapshot_buffer");

      const savedAt = Date.now();

      for (let seq = 0; seq * SNAPSHOT_CHUNK_BYTES < update.length || seq === 0; seq++) {
        const chunk = update.slice(seq * SNAPSHOT_CHUNK_BYTES, (seq + 1) * SNAPSHOT_CHUNK_BYTES);

        this.ctx.storage.sql.exec(
          "INSERT INTO snapshot_buffer (seq, content, saved_at) VALUES (?, ?, ?)",
          seq,
          chunk.buffer as ArrayBuffer,
          savedAt
        );
      }
    });
  }

  private clearBuffer() {
    this.ctx.storage.sql.exec("DELETE FROM snapshot_buffer");
  }
}
