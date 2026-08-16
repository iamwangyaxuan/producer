import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { Edge } from "@xyflow/react";
import { eq } from "drizzle-orm";
import * as Y from "yjs";

import type { GenerationNode } from "#/components/block/studio/generation-node";
import { getDB, schema } from "#/db";
import {
  edgesMap,
  nodeDataMap,
  nodesMap,
  orderedEdges,
  orderedNodes,
  toNode
} from "#/lib/canvas/doc";
import { canonicalId } from "#/lib/ids";
import { getProjectAccess } from "#/server/canvas-access";

/**
 * The canvas of an archived project, read once and never written.
 *
 * This is what makes "archived is read-only" a fact about the system rather
 * than a promise the client keeps. The live canvas is a Durable Object holding
 * a Yjs document, and any client that can open that socket can write to it — so
 * a read-only *mode* of the collaborative canvas would be a mode enforced in
 * the browser, which is no enforcement at all. An archived project instead
 * never opens the socket: `canAccessProjectCanvas` still refuses it, and the
 * board is rebuilt from the snapshot the room last saved.
 *
 * What crosses the wire is the Yjs update itself, base64'd — the same bytes the
 * room would have sent over the socket. Two reasons it is not decoded into
 * nodes here. A server function's return type has to be plainly serializable,
 * and React Flow's `Node`/`Edge` are not — they describe a live canvas object
 * rather than a payload, and the checker is right to refuse them. And decoding
 * on the client means the archived board is assembled by *exactly* the code
 * that assembles the live one, down to `toNode`'s rule for a geometry record
 * whose data never arrived, rather than by a second implementation that could
 * lay the same document out differently.
 *
 * One honest limit: the snapshot is what the room last *saved*, so a project
 * archived in the same moment somebody was dragging a node can be behind by one
 * save. Nobody is editing an archived project by definition, and the room
 * saves once more on its way down.
 */

export interface CanvasSnapshotPayload {
  /** The Yjs update, base64. `null` when this project never had a canvas row. */
  update: string | null;
}

const EMPTY: CanvasSnapshotPayload = { update: null };

function toBase64(bytes: Uint8Array) {
  let binary = "";

  // Chunked rather than one spread: `String.fromCharCode(...bytes)` on a
  // canvas of any size blows the argument limit, and these run to hundreds of
  // kilobytes.
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }

  return btoa(binary);
}

export const fetchCanvasSnapshot = createServerFn({ method: "GET" })
  .validator(canonicalId)
  .handler(async ({ data: projectId }): Promise<CanvasSnapshotPayload> => {
    // `allowArchived`, which is the whole point of this endpoint — and still a
    // full membership check, so an archived project is no more readable by an
    // outsider than a live one is.
    const access = await getProjectAccess(getRequest().headers, projectId, { allowArchived: true });

    if (!access) return EMPTY;

    const [row] = await getDB()
      .select({ content: schema.canvasSnapshot.content })
      .from(schema.canvasSnapshot)
      .where(eq(schema.canvasSnapshot.projectId, projectId))
      .limit(1);

    // A project archived before anything was ever put on its canvas has no row.
    // An empty board is the truthful answer.
    return row ? { update: toBase64(row.content) } : EMPTY;
  });

/**
 * Keyed under the project rather than the organization prefix: it is a fact
 * about one project, and the only thing that changes it is that project being
 * restored — which invalidates the project queries and takes this page off
 * screen anyway.
 */
export function canvasSnapshotQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: ["projects", projectId, "canvas-snapshot"],
    queryFn: ({ signal }) => fetchCanvasSnapshot({ data: projectId, signal }),
    // An archived canvas does not change while it is being looked at. Long
    // enough that panning around never refetches it, short enough that a
    // restore, edit and re-archive is not served from before all three.
    staleTime: 5 * 60_000
  });
}

/**
 * The payload turned back into a board, with the live canvas's own helpers.
 *
 * A plain function rather than a hook: it is called once per payload from a
 * `useMemo`, and there is nothing to subscribe to — an archived document does
 * not change under the reader.
 */
export function decodeCanvasSnapshot(payload: CanvasSnapshotPayload | undefined): {
  nodes: GenerationNode[];
  edges: Edge[];
} {
  if (!payload?.update) return { nodes: [], edges: [] };

  const doc = new Y.Doc();

  try {
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(payload.update), (char) => char.charCodeAt(0))
    );

    const data = nodeDataMap(doc);

    return {
      nodes: orderedNodes(nodesMap(doc)).flatMap((record) => {
        const node = toNode(record, data.get(record.id));

        return node ? [node] : [];
      }),
      edges: orderedEdges(edgesMap(doc))
    };
  } finally {
    // A scratch decoder, not a session: left alive it keeps its structures for
    // as long as the tab does.
    doc.destroy();
  }
}
