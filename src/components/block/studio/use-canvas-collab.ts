import { addEdge, applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import type { Connection, Edge, EdgeChange, NodeChange, XYPosition } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";

import { freePosition, tidyPositions } from "#/components/block/studio/canvas-placement";
import { nodeSize } from "#/components/block/studio/generation-node";
import type { GenerationNode, GenerationNodeData } from "#/components/block/studio/generation-node";
import {
  nextOrder,
  orderedEdges,
  orderedNodes,
  toNode,
  toStored,
  toStoredEdge,
  updateStoredData,
  updateStoredPosition,
  updateStoredSize
} from "#/lib/canvas/doc";
import type { StoredNode } from "#/lib/canvas/doc";
import type { PresenceState, PresenceUser } from "#/lib/canvas/presence";
import { createCanvasSession } from "#/lib/canvas/session";
import type { CanvasSession } from "#/lib/canvas/session";
import { throttled } from "#/lib/canvas/throttle";

/** One connected client as the rest of the canvas sees it. */
export interface CanvasPeer extends PresenceState {
  clientId: number;
}

export interface CanvasCollabOptions {
  projectId: string;
  user: PresenceUser;
  /**
   * Fired whenever nodes leave the document — deleted here or on another
   * machine — so work still running for them can be called off.
   */
  onNodesRemoved?: (ids: string[]) => void;
  /**
   * Whether this tab is still working on the node's generation. The timeout
   * sweep asks before declaring anything failed, so a slow request this very
   * tab is running is never shot down by its own watchdog.
   */
  isGenerating?: (id: string) => boolean;
}

/**
 * How often a continuous gesture writes to the shared document. Drags and
 * resizes emit once per frame; every write is a document update that is
 * broadcast, applied and appended to the history, so the stream is thinned to
 * roughly the rate remote cursors are drawn at anyway. The gesture's final
 * change is always written unthrottled — the document must end exactly where
 * the node was dropped.
 */
const GESTURE_WRITE_MS = 60;

/**
 * How long a generation may stay pending before any client is allowed to
 * declare it failed. Generation runs in the creator's tab, so a tab that
 * closes mid-request leaves a skeleton that would otherwise load forever on
 * every other screen. The judgement is made on the node's own `requestedAt`
 * clock rather than on presence: awareness is rebuilt empty when the room
 * wakes from hibernation, so "the creator is not in awareness" routinely
 * describes a perfectly live tab — but "this has been pending for minutes"
 * does not. While the owning tab lives, it renews `requestedAt` every minute
 * (uploads and generations both), so only genuinely abandoned work ever ages
 * past this.
 */
const GENERATION_TIMEOUT_MS = 120_000;

const ORPHAN_SWEEP_MS = 5_000;

/**
 * How many sweep ticks a pending node must sit unmoved *and already stale*
 * under this tab's watch before it may be declared failed — a full timeout's
 * worth. Counted in ticks rather than wall time because a suspended tab's
 * wall clock keeps running while it observes nothing: sleep a laptop through
 * a completion and a wall-clock watch would shoot the finished node on the
 * first tick after waking, before the dead socket is even noticed (the
 * provider has no silent link detection — `synced` stays true until the
 * browser reports the close). Ticks only accrue while the sweep actually
 * runs, and only once the node is stale by its own clock — a node kept fresh
 * by heartbeats must not bank ticks against the day its age finally lapses —
 * so a verdict lands roughly two timeouts after the last heartbeat, never on
 * a wake-up's first look.
 */
const WATCH_TICKS = GENERATION_TIMEOUT_MS / ORPHAN_SWEEP_MS;

/**
 * A gap between consecutive sweep ticks that no healthy interval produces:
 * past it, this tab was suspended or frozen rather than watching, and
 * whatever the watch accumulated describes a world it stopped seeing.
 */
const WATCH_GAP_RESET_MS = ORPHAN_SWEEP_MS * 3;

/**
 * How often this tab re-announces itself through awareness. Well under the
 * protocol's 30-second staleness cutoff, and cheap: a heartbeat is a few
 * bytes that are never persisted and never enter the document's history.
 */
const HEARTBEAT_MS = 20_000;

/**
 * The canvas graph, shared. Everything React Flow renders comes out of here,
 * and every mutation goes back through it: local changes are applied to React
 * state and written into the Yjs document in the same breath, remote changes
 * arrive through the document's observers and are folded into React state with
 * this machine's runtime-only fields (selection, an in-progress drag, the
 * browser's measurements) carried over rather than reset.
 *
 * The document is the durable record — the Durable Object it syncs through
 * persists it, which is also what "the canvas survives a reload" means — and
 * awareness is the ephemeral one: cursors and who-is-here live only as long as
 * the connections that announce them.
 */
export function useCanvasCollab({
  projectId,
  user,
  onNodesRemoved,
  isGenerating
}: CanvasCollabOptions) {
  const [nodes, setNodes] = useState<GenerationNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [peers, setPeers] = useState<CanvasPeer[]>([]);
  const [clientId, setClientId] = useState<number | null>(null);

  const session = useRef<CanvasSession | null>(null);

  /**
   * Mirrors of the two state values, so the mutation functions below can read
   * the freshest list without going through a state updater — updaters have to
   * stay pure, and these writes have side effects (the Yjs transaction) that
   * belong exactly where the next list is computed.
   */
  const nodesRef = useRef<GenerationNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);

  const removedCallback = useRef(onNodesRemoved);
  const generating = useRef(isGenerating);

  useEffect(() => {
    removedCallback.current = onNodesRemoved;
    generating.current = isGenerating;
  }, [onNodesRemoved, isGenerating]);

  function commitNodes(next: GenerationNode[]) {
    nodesRef.current = next;
    setNodes(next);
  }

  function commitEdges(next: Edge[]) {
    edgesRef.current = next;
    setEdges(next);
  }

  /**
   * Writes from continuous gestures, batched per node and flushed on a
   * trailing throttle. `immediate` is for a gesture's sign-off — and for
   * one-off moves like a keyboard nudge — where waiting would leave the
   * document briefly wrong about where things settled.
   */
  const pendingWrites = useRef(
    new Map<string, Partial<Pick<StoredNode, "position" | "width" | "height">>>()
  );

  function flushWrites() {
    const current = session.current;
    const writes = pendingWrites.current;

    if (!current || writes.size === 0) return;

    current.doc.transact(() => {
      for (const [id, patch] of writes) {
        if (patch.position) updateStoredPosition(current.nodes, id, patch.position);
        if (patch.width !== undefined && patch.height !== undefined) {
          updateStoredSize(current.nodes, id, { width: patch.width, height: patch.height });
        }
      }
    }, current.localOrigin);
    writes.clear();
  }

  const throttledFlush = useMemo(() => throttled(GESTURE_WRITE_MS, flushWrites), []);

  function queueWrite(
    id: string,
    patch: Partial<Pick<StoredNode, "position" | "width" | "height">>,
    immediate: boolean
  ) {
    const pending = pendingWrites.current.get(id);

    pendingWrites.current.set(id, { ...pending, ...patch });

    if (immediate) flushWrites();
    else throttledFlush();
  }

  /** The session's lifetime is the canvas's: connect on mount, tear down on leave. */
  useEffect(() => {
    const created = createCanvasSession(projectId, user);

    session.current = created;
    setClientId(created.clientId);

    /**
     * The whole list is rebuilt from the document rather than patched from the
     * event: the document is the one ordering every machine agrees on, and a
     * rebuild is how a node added remotely lands in the same stacking position
     * everywhere. Per-machine state is carried over from the previous list —
     * and a node this person is mid-drag or mid-resize on keeps its local
     * position outright, because a remote write to it is a fight the person
     * holding it should win until they let go.
     */
    function reconcileNodes() {
      const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
      const next = orderedNodes(created.nodes).flatMap((record) => {
        const before = previous.get(record.id);

        if (before?.dragging || before?.resizing) return [before];

        const node = toNode(record, created.nodeData.get(record.id), before);

        return node ? [node] : [];
      });

      commitNodes(next);
    }

    function reconcileEdges() {
      const previous = new Map(edgesRef.current.map((edge) => [edge.id, edge]));

      commitEdges(
        orderedEdges(created.edges).map((edge) => {
          const selected = previous.get(edge.id)?.selected;

          return selected ? { ...edge, selected } : edge;
        })
      );
    }

    function onNodesEvent(event: Y.YMapEvent<StoredNode>, transaction: Y.Transaction) {
      if (transaction.local) return;

      const removed: string[] = [];

      event.changes.keys.forEach((change, key) => {
        if (change.action === "delete") removed.push(key);
      });

      if (removed.length > 0) removedCallback.current?.(removed);

      reconcileNodes();
    }

    function onNodeDataEvent(_event: Y.YMapEvent<GenerationNodeData>, transaction: Y.Transaction) {
      if (transaction.local) return;

      reconcileNodes();
    }

    function onEdgesEvent(_event: Y.YMapEvent<Edge>, transaction: Y.Transaction) {
      if (transaction.local) return;

      reconcileEdges();
    }

    function onAwarenessChange() {
      const states: CanvasPeer[] = [];

      for (const [id, state] of created.awareness.getStates()) {
        // A state can be half-formed while a client is still seeding itself.
        if (state && typeof state === "object" && "user" in state) {
          states.push({ clientId: id, ...(state as PresenceState) });
        }
      }

      setPeers(states);
    }

    created.nodes.observe(onNodesEvent);
    created.nodeData.observe(onNodeDataEvent);
    created.edges.observe(onEdgesEvent);
    // "change" is the content event; "update" also fires for protocol-level
    // renewals that alter nothing worth re-rendering for.
    created.awareness.on("change", onAwarenessChange);

    /**
     * A heartbeat through awareness, because this stack sends nothing on its
     * own: y-partyserver disables the protocol's periodic re-announcement so
     * idle rooms can hibernate, and a room that *does* hibernate wakes with an
     * empty awareness table — anyone joining then would see nobody until the
     * others next moved a cursor. Touching a timestamp field is a real content
     * change, so it is broadcast, and every silent tab re-introduces itself
     * well before anyone stares at an empty avatar strip for long.
     */
    const heartbeat = setInterval(() => {
      created.awareness.setLocalStateField("heartbeat", Date.now());
    }, HEARTBEAT_MS);

    // The document may already hold state (a second tab shares it over the
    // BroadcastChannel before the socket even opens), and awareness always at
    // least holds this client.
    reconcileNodes();
    reconcileEdges();
    onAwarenessChange();

    return () => {
      clearInterval(heartbeat);
      created.awareness.off("change", onAwarenessChange);
      session.current = null;
      created.destroy();
      pendingWrites.current.clear();
      commitNodes([]);
      commitEdges([]);
      setPeers([]);
      setClientId(null);
    };
    // Only the *who* rebuilds the session — a rename or new avatar updates the
    // announced identity in place below. Tearing the connection down for it
    // would strand generations mid-flight behind a brand-new client id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, user.id]);

  /**
   * Identity refreshes ride the live awareness state instead of a reconnect:
   * a profile rename or avatar change mid-session is a label update, not a
   * different person arriving.
   */
  useEffect(() => {
    session.current?.awareness.setLocalStateField("user", user);
  }, [user]);

  /**
   * Field updates on a node's data — a generation resolving, mostly. Read-
   * modify-write against the latest record, so a result landing while someone
   * else is dragging the node does not also drag it back to where it started.
   *
   * Declared above the effect that uses it: hoisting would carry it there
   * anyway, but the React Compiler refuses to compile a hook that reads a
   * variable before its declaration, and this hook is the one that most wants
   * compiling.
   */
  function patchNodeData(id: string, patch: Partial<GenerationNodeData>) {
    const current = session.current;

    if (!current) return;

    current.doc.transact(() => {
      updateStoredData(current.nodeData, id, patch);
    }, current.localOrigin);
    commitNodes(
      nodesRef.current.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
      )
    );
  }

  /**
   * The watchdog for generations whose tab has gone. Two clocks must agree
   * before anything is shot: the node's own `requestedAt` must be a timeout
   * stale, *and* this tab must have watched it sit unmoved through a full
   * timeout's worth of sweep ticks. The second condition is what survives
   * both clock skew — a machine running minutes fast sees every fresh node
   * as ancient by the first test alone — and suspension, where wall time
   * passes but nothing was observed (see `WATCH_TICKS`). Since the owning
   * tab renews `requestedAt` every minute while its request lives, any
   * movement restarts the watch.
   *
   * The verdict is written through the same read-modify-write merge as every
   * data patch, so it keeps the node's `assetId` — but a verdict truly
   * concurrent with the completion patch is still whole-record
   * last-writer-wins, settled by client id, not by arrival order. The double
   * requirement makes that window a failure of last resort, not a race the
   * design leans on.
   */
  useEffect(() => {
    /** What this tab has itself seen of each pending node: the last `requestedAt` it observed, and how many stale ticks it has sat unmoved. */
    const watched = new Map<string, { requestedAt: number | undefined; ticks: number }>();

    let lastTickAt = Date.now();

    const sweep = setInterval(() => {
      const current = session.current;

      if (!current || !current.provider.synced) return;

      const now = Date.now();

      // Ticks skipped — suspension, a frozen tab, an unsynced stretch that
      // early-returned above — mean nothing was observed; a watch matured
      // while not watching is exactly the false verdict this exists to
      // avoid, so it starts over. (A socket that dies *silently* still gets
      // fresh ticks against a frozen replica — `synced` only flips on a
      // reported close — but that verdict needs two further timeouts of
      // silence, and the owner's completion patch merges back over it when
      // the link resumes.)
      if (now - lastTickAt > WATCH_GAP_RESET_MS) watched.clear();
      lastTickAt = now;

      const pending = new Set<string>();

      for (const [id, data] of current.nodeData.entries()) {
        if (data.status !== "pending") continue;

        pending.add(id);

        if (generating.current?.(id)) continue;

        // Movement is the owner's heartbeat, whatever the clocks say; any
        // change to `requestedAt` restarts this tab's watch.
        const seen = watched.get(id);
        if (!seen || seen.requestedAt !== data.requestedAt) {
          watched.set(id, { requestedAt: data.requestedAt, ticks: 0 });
          continue;
        }

        // Fresh by its own clock: no tick accrues, or a node kept alive by
        // heartbeats would bank ticks and be shot the moment its age lapsed.
        if (data.requestedAt !== undefined && now - data.requestedAt < GENERATION_TIMEOUT_MS) {
          continue;
        }

        seen.ticks++;

        if (seen.ticks < WATCH_TICKS) continue;

        patchNodeData(id, { status: "failed" });
      }

      // Nodes that resolved or left take their bookkeeping with them.
      for (const id of watched.keys()) {
        if (!pending.has(id)) watched.delete(id);
      }
    }, ORPHAN_SWEEP_MS);

    return () => clearInterval(sweep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /**
   * React Flow's changes, applied locally and forwarded into the document.
   * Selection stays on this machine; positions and sizes travel — thinned
   * while a gesture is in flight, exact when it ends.
   */
  function applyNodesChange(changes: NodeChange<GenerationNode>[]) {
    commitNodes(applyNodeChanges(changes, nodesRef.current));

    const current = session.current;

    if (!current) return;

    // A resize pairs its dimension change with a position change that carries
    // no `dragging` flag; without looking at the whole batch those positions
    // would be mistaken for discrete moves and written every frame.
    const midResize = changes.some((change) => change.type === "dimensions" && change.resizing);

    const removed: string[] = [];

    /**
     * Nodes whose drag or resize ended in this batch. While the gesture ran,
     * every remote write to them was deliberately ignored — the hand holding a
     * node wins — so whatever the document accumulated for them meanwhile (a
     * generation resolving, mostly) has to be folded back in now. Without
     * this, a result that landed mid-drag stays a skeleton until some later
     * remote change happens to trigger a reconcile.
     */
    const ended: string[] = [];

    current.doc.transact(() => {
      for (const change of changes) {
        switch (change.type) {
          case "position": {
            if (!change.position) break;

            if (change.dragging === false) ended.push(change.id);
            queueWrite(change.id, { position: change.position }, !change.dragging && !midResize);
            break;
          }
          case "dimensions": {
            if (!change.dimensions) break;

            // Three kinds of dimension change arrive here and only two may
            // write: live resizes (`setAttributes`) and the resize's sign-off
            // (`resizing === false`). The third — the browser reporting what it
            // measured — describes this machine's rendering, not an edit.
            if (change.setAttributes) {
              queueWrite(change.id, change.dimensions, false);
            } else if (change.resizing === false) {
              ended.push(change.id);

              // The sign-off is trusted for its timing, never for its numbers:
              // React Flow derives it from the pointer alone and has not heard
              // about the snapping, so its dimensions are the size the resize
              // would have been *without* the guide it just met. The node in
              // local state holds what the live changes actually wrote — the
              // snapped size and position — and that is what must land in the
              // document, or every other screen (and this one, after a reload)
              // shows the node sprung off the guide.
              const settled = nodesRef.current.find((node) => node.id === change.id);

              queueWrite(
                change.id,
                settled?.width !== undefined && settled.height !== undefined
                  ? { position: settled.position, width: settled.width, height: settled.height }
                  : { ...change.dimensions, position: settled?.position },
                true
              );
            }
            break;
          }
          case "remove": {
            pendingWrites.current.delete(change.id);
            current.nodes.delete(change.id);
            current.nodeData.delete(change.id);
            removed.push(change.id);
            break;
          }
          case "add":
          case "replace": {
            const record = current.nodes.get(change.item.id);

            current.nodes.set(
              change.item.id,
              toStored(change.item, record?.order ?? nextOrder(current.nodes))
            );
            current.nodeData.set(change.item.id, change.item.data);
            break;
          }
          // "select" is per-person state and never travels.
        }
      }
    }, current.localOrigin);

    if (ended.length > 0) {
      commitNodes(
        nodesRef.current.flatMap((node) => {
          if (!ended.includes(node.id)) return [node];

          const record = current.nodes.get(node.id);

          // No record means the node was deleted remotely while it was being
          // held; the delete was suppressed for the gesture's sake and takes
          // effect now that the hand is off it.
          if (!record) return [];

          const merged = toNode(record, current.nodeData.get(node.id), node);

          return merged ? [merged] : [node];
        })
      );
    }

    if (removed.length > 0) removedCallback.current?.(removed);
  }

  function applyEdgesChange(changes: EdgeChange<Edge>[]) {
    commitEdges(applyEdgeChanges(changes, edgesRef.current));

    const current = session.current;

    if (!current) return;

    current.doc.transact(() => {
      for (const change of changes) {
        if (change.type === "remove") current.edges.delete(change.id);
        else if (change.type === "add" || change.type === "replace") {
          current.edges.set(change.item.id, toStoredEdge(change.item));
        }
      }
    }, current.localOrigin);
  }

  function connect(connection: Connection) {
    const next = addEdge(connection, edgesRef.current);
    const added = next.filter((edge) => !edgesRef.current.some((has) => has.id === edge.id));

    commitEdges(next);

    const current = session.current;

    if (!current || added.length === 0) return;

    current.doc.transact(() => {
      for (const edge of added) current.edges.set(edge.id, toStoredEdge(edge));
    }, current.localOrigin);
  }

  /**
   * A new generation lands near `centre`, in the first clear spot. The
   * placement is worked out against the document itself rather than React
   * state because the document is updated synchronously by every local write —
   * two submissions in the same tick each see the node the other just placed.
   */
  function addGeneration(data: GenerationNodeData, centre: XYPosition): string | null {
    const current = session.current;

    if (!current) return null;

    // Stamped here so every generation carries its age: the timeout sweep
    // above is what turns an abandoned request into a failed node, and it can
    // only count from a time the node itself remembers.
    const stamped: GenerationNodeData = { ...data, requestedAt: Date.now() };

    const size = nodeSize(stamped);
    const anchor = { x: centre.x - size.width / 2, y: centre.y - size.height / 2 };
    const taken = orderedNodes(current.nodes);

    const node: GenerationNode = {
      id: crypto.randomUUID(),
      type: "generation",
      // Written on the node rather than left to CSS: these are what the resize
      // controls change, and a node with no dimensions of its own has nothing
      // for them to take hold of.
      width: size.width,
      height: size.height,
      // Placement only needs geometry, which the records already are.
      position: freePosition(anchor, size, taken),
      data: stamped
    };

    current.doc.transact(() => {
      current.nodes.set(node.id, toStored(node, nextOrder(current.nodes)));
      current.nodeData.set(node.id, stamped);
    }, current.localOrigin);
    commitNodes([...nodesRef.current, node]);

    return node.id;
  }

  function tidy() {
    const current = session.current;

    if (!current) return;

    const layout = tidyPositions(nodesRef.current);

    current.doc.transact(() => {
      for (const [id, position] of layout) updateStoredPosition(current.nodes, id, position);
    }, current.localOrigin);
    commitNodes(
      nodesRef.current.map((node) => {
        const position = layout.get(node.id);

        return position ? { ...node, position } : node;
      })
    );
  }

  /**
   * This person's pointer, shared through awareness in flow coordinates so
   * every zoom level draws it in the right place. Throttled — every write is a
   * broadcast — except leaving, which cancels anything queued so a stale
   * position cannot arrive after the goodbye.
   */
  const sendCursor = useMemo(
    () =>
      throttled(GESTURE_WRITE_MS, (cursor: { x: number; y: number }) => {
        session.current?.awareness.setLocalStateField("cursor", cursor);
      }),
    []
  );

  function setCursor(cursor: { x: number; y: number } | null) {
    if (cursor) {
      sendCursor(cursor);

      return;
    }

    sendCursor.cancel();
    session.current?.awareness.setLocalStateField("cursor", null);
  }

  useEffect(() => {
    return () => {
      sendCursor.cancel();
      throttledFlush.cancel();
    };
  }, [sendCursor, throttledFlush]);

  return {
    nodes,
    edges,
    peers,
    clientId,
    applyNodesChange,
    applyEdgesChange,
    connect,
    addGeneration,
    patchNodeData,
    tidy,
    setCursor
  };
}
