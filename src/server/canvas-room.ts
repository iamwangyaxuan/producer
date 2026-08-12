import type { Connection, ConnectionContext } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

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
 * Chunk size for the persisted snapshot. A SQLite value in Durable Object
 * storage caps out at 2 MB, and a snapshot that crossed it would make every
 * save throw — logged, swallowed, and silently rolling the canvas back to the
 * last good save on the next cold start. Splitting rows removes the cliff.
 */
const SNAPSHOT_CHUNK_BYTES = 1_000_000;

/** What each connection remembers about who opened it. ≤2 KB, per the platform. */
interface ConnectionAuth {
  cookie: string;
}

/**
 * One Durable Object per project canvas, named by the project id.
 *
 * y-partyserver runs the whole Yjs wire protocol — sync on connect, update
 * relay, awareness for cursors and presence — so what is owned here is
 * durability and tenancy: the document is loaded from this object's SQLite
 * storage when the room wakes, written back on y-partyserver's debounced
 * save, and every connection is periodically re-checked against the same
 * membership rules that guard the project's HTTP reads.
 */
export class CanvasRoom extends YServer {
  /**
   * Hibernation keeps an idle room from being billed as a running one: open
   * sockets survive eviction and the document is rebuilt from storage on the
   * next message. Supported by y-partyserver since 2.1.0, which moved its
   * awareness bookkeeping into the sockets themselves for exactly this.
   */
  static options = { hibernate: true };

  async onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS canvas_snapshot (id TEXT NOT NULL, seq INTEGER NOT NULL, content BLOB NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY (id, seq))"
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

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + REVALIDATE_MS);
    }

    return super.onConnect(connection, ctx);
  }

  /**
   * The standing half of the door check: connections whose session no longer
   * passes — signed out everywhere, removed from the organization, project
   * archived — are closed, and the client's reconnect attempt runs into the
   * worker's `onBeforeConnect` gate, which now refuses it.
   */
  async onAlarm() {
    let connections = 0;

    for (const connection of this.getConnections<ConnectionAuth>()) {
      connections++;

      const headers = new Headers({ cookie: connection.state?.cookie ?? "" });

      let allowed = false;

      try {
        allowed = await canAccessProjectCanvas(headers, this.name);
      } catch (error) {
        // The database being unreachable is not evidence anyone's access was
        // revoked; keeping the room alive is the conservative answer.
        console.error("canvas access revalidation failed:", error);
        allowed = true;
      }

      if (!allowed) connection.close(4001, "Access revoked");
    }

    if (connections > 0) {
      await this.ctx.storage.setAlarm(Date.now() + REVALIDATE_MS);
    }
  }

  async onLoad() {
    const rows = this.ctx.storage.sql
      .exec("SELECT content FROM canvas_snapshot WHERE id = ? ORDER BY seq", this.name)
      .toArray();

    if (rows.length === 0) return;

    const chunks = rows.map((row) =>
      row.content instanceof ArrayBuffer ? new Uint8Array(row.content) : new Uint8Array(0)
    );
    const update = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));

    let offset = 0;

    for (const chunk of chunks) {
      update.set(chunk, offset);
      offset += chunk.length;
    }

    Y.applyUpdate(this.document, update);
  }

  async onSave() {
    // A full snapshot every time rather than an update log: re-encoding also
    // garbage-collects everything deleted, so the stored document stays the
    // size of what is on the canvas, not the size of its history.
    const update = Y.encodeStateAsUpdate(this.document);

    // Replace-all inside one transaction, so a crash between the delete and
    // the last insert cannot leave half a snapshot to be restored from.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM canvas_snapshot WHERE id = ?", this.name);

      const savedAt = Date.now();

      for (let seq = 0; seq * SNAPSHOT_CHUNK_BYTES < update.length || seq === 0; seq++) {
        const chunk = update.slice(seq * SNAPSHOT_CHUNK_BYTES, (seq + 1) * SNAPSHOT_CHUNK_BYTES);

        this.ctx.storage.sql.exec(
          "INSERT INTO canvas_snapshot (id, seq, content, saved_at) VALUES (?, ?, ?, ?)",
          this.name,
          seq,
          chunk.buffer as ArrayBuffer,
          savedAt
        );
      }
    });
  }
}
