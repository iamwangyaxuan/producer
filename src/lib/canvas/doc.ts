import type { Edge } from "@xyflow/react";
import * as Y from "yjs";

import type { GenerationNode, GenerationNodeData } from "#/components/block/studio/generation-node";

/**
 * The shape of the shared canvas document.
 *
 * Three top-level maps, all keyed by node/edge id and holding plain JSON
 * records rather than nested Y types. Geometry and data live in *separate*
 * maps on purpose: a plain-object value in a Y.Map is opaque to the CRDT, so
 * two truly concurrent writes to the same key keep exactly one whole record —
 * whichever client's id sorts higher — and if a drag stream and a
 * generation-finished patch shared a key, the drag could silently erase the
 * result. Split across two maps they can never meet: drags write `nodes`,
 * results write `nodeData`, and the worst concurrent same-key conflict left
 * is two people doing the *same kind* of edit to one node, where keeping
 * either write is a correct answer.
 *
 * Within each map, writes still read the latest record first and change only
 * the fields they are about, which settles everything that is merely
 * causally ordered.
 */

/** The durable geometry of a node. Runtime state — selection, dragging, measurements — stays on the machine it happened on. */
export interface StoredNode {
  id: string;
  type: "generation";
  position: { x: number; y: number };
  width: number;
  height: number;
  /**
   * Creation time, because a Y.Map has no order of its own and the canvas needs
   * everyone to stack overlapping nodes the same way round. Client clocks are
   * good enough here — a tie only decides which of two overlapping nodes sits
   * on top, and the id breaks it deterministically.
   */
  order: number;
}

export function nodesMap(doc: Y.Doc): Y.Map<StoredNode> {
  return doc.getMap<StoredNode>("nodes");
}

/** Each node's `data`, keyed by the node's id — see the module comment for why it lives apart. */
export function nodeDataMap(doc: Y.Doc): Y.Map<GenerationNodeData> {
  return doc.getMap<GenerationNodeData>("nodeData");
}

export function edgesMap(doc: Y.Doc): Y.Map<Edge> {
  return doc.getMap<Edge>("edges");
}

/** What a node's geometry looks like on its way into the document. */
export function toStored(node: GenerationNode, order: number): StoredNode {
  return {
    id: node.id,
    type: "generation",
    position: { x: node.position.x, y: node.position.y },
    // The node always carries its own dimensions on this canvas — they are
    // written at creation and maintained by the resize controls — so the
    // fallbacks only guard against a node manufactured somewhere new.
    width: node.width ?? node.measured?.width ?? 0,
    height: node.height ?? node.measured?.height ?? 0,
    order
  };
}

/**
 * A stored record turned back into a live node. `previous` is the node this
 * client already had, and everything that only ever meant something locally —
 * selection, an in-progress drag, the browser's own measurements — is carried
 * over from it rather than reset by a remote write. `data` can be absent for
 * the moment a peer's two-map write is half-applied; the previous data, or a
 * placeholder that will be overwritten in the same tick, covers the gap.
 */
export function toNode(
  record: StoredNode,
  data: GenerationNodeData | undefined,
  previous?: GenerationNode
): GenerationNode | null {
  const resolved = data ?? previous?.data;

  if (!resolved) return null;

  return {
    ...previous,
    id: record.id,
    type: "generation",
    position: { ...record.position },
    width: record.width,
    height: record.height,
    data: resolved
  };
}

/** The render list: every stored node, stacked the same way on every machine. */
export function orderedNodes(map: Y.Map<StoredNode>): StoredNode[] {
  return [...map.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The next `order` for a node created now, monotonic even against a skewed clock. */
export function nextOrder(map: Y.Map<StoredNode>): number {
  let latest = 0;

  for (const record of map.values()) {
    if (record.order > latest) latest = record.order;
  }

  return Math.max(Date.now(), latest + 1);
}

/**
 * Field-scoped updates on top of whatever is in the map right now. Each one is
 * a read-modify-write of a single record inside a transaction, which is what
 * keeps two causally-ordered edits to different fields from overwriting each
 * other with stale copies.
 */

export function updateStoredPosition(
  map: Y.Map<StoredNode>,
  id: string,
  position: { x: number; y: number }
) {
  const record = map.get(id);

  if (record) map.set(id, { ...record, position: { x: position.x, y: position.y } });
}

export function updateStoredSize(
  map: Y.Map<StoredNode>,
  id: string,
  size: { width: number; height: number }
) {
  const record = map.get(id);

  if (record) map.set(id, { ...record, width: size.width, height: size.height });
}

export function updateStoredData(
  map: Y.Map<GenerationNodeData>,
  id: string,
  patch: Partial<GenerationNodeData>
) {
  const data = map.get(id);

  if (data) map.set(id, { ...data, ...patch });
}

/** An edge on its way into the document, stripped of the machine-local flags. */
export function toStoredEdge(edge: Edge): Edge {
  const { selected: _selected, ...stored } = edge;

  return stored;
}

/**
 * Edges in a stable order. Nothing about an edge says when it was made, so id
 * order stands in — arbitrary, but the same arbitrary everywhere, which is
 * what keeps two crossing edges stacked the same way on every machine and
 * after every reload.
 */
export function orderedEdges(map: Y.Map<Edge>): Edge[] {
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}
