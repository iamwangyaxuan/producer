import { BaseEdge, getBezierPath, Position, useInternalNode } from "@xyflow/react";
import type {
  DefaultEdgeOptions,
  Edge,
  EdgeProps,
  EdgeTypes,
  InternalNode,
  Node
} from "@xyflow/react";

/**
 * The one kind of connection this canvas has: a line from the node a generation
 * was made from into the generation itself.
 *
 * Named rather than left as React Flow's `default`, because the name is what
 * says the graph has a meaning — every line on this board is "that file went
 * into this result", never a connection someone drew for their own reasons.
 */
export const REFERENCE_EDGE_TYPE = "reference";

/**
 * Only the two ends and the kind are recorded, and `source` is always the node
 * that was referenced.
 *
 * Which way round that is has no mark on the line — there is no arrowhead and
 * nothing animates along it — so the direction lives in the graph alone. It
 * still has to be right: it is what a reader of this document, and anything
 * later built on it, will take "made from" to mean.
 */
export function referenceEdge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target, type: REFERENCE_EDGE_TYPE };
}

interface Box {
  centreX: number;
  centreY: number;
  width: number;
  height: number;
}

function boxOf(node: InternalNode<Node>): Box {
  const width = node.measured.width ?? node.width ?? 0;
  const height = node.measured.height ?? node.height ?? 0;

  return {
    centreX: node.internals.positionAbsolute.x + width / 2,
    centreY: node.internals.positionAbsolute.y + height / 2,
    width,
    height
  };
}

/**
 * Where the line leaves a node on its way towards `dx, dy`, and which way it is
 * facing when it does.
 *
 * Both answers come out of the same question: scale the direction until it
 * touches the box's vertical edges, scale it until it touches the horizontal
 * ones, and whichever happens first is the side the line actually crosses — the
 * other scaling has already left the rectangle. So the smaller factor gives the
 * point, and which of the two it was gives the side. An axis the line does not
 * travel on cannot be the first thing it crosses, which is what the infinities
 * stand for.
 */
function exitAt(box: Box, dx: number, dy: number) {
  const horizontal = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const vertical = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const scale = Math.min(horizontal, vertical);

  return {
    x: box.centreX + dx * scale,
    y: box.centreY + dy * scale,
    position:
      horizontal <= vertical
        ? dx > 0
          ? Position.Right
          : Position.Left
        : dy > 0
          ? Position.Bottom
          : Position.Top
  };
}

/**
 * React Flow's own bezier between the two nodes, with a line of lights running
 * along it from the referenced node to the result.
 *
 * The curve is the library's — `getBezierPath`, drawn by `BaseEdge`. What it is
 * not given is the handles' own coordinates, and that is the whole reason this
 * component computes anything: a handle is pinned to one side of a node, and
 * nodes here stop wherever they were dropped. Pinned to the right, a line whose
 * result sits to the *left* of its source left the far side of the node,
 * doubled back, and lay across both cards on the way. Leaving each box in the
 * direction of the other — and telling the bezier which side that turned out to
 * be, so it bends the right way out of the gate — is the one rule that reads
 * correctly from every direction. It is also React Flow's own recipe for it;
 * the handles stay because the library will not place an edge whose ends do not
 * resolve to one, but nothing about where they sit is used here.
 *
 * One stroke, and it is React Flow's own: `BaseEdge`, in the colour the theme
 * gives `--xy-edge-stroke`. Nothing is drawn on top of it — no arrowhead, no
 * light travelling along it, nothing animated. A canvas of pictures is a place
 * where the pictures should be the only thing moving.
 */
function ReferenceEdge({ source, target }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!sourceNode || !targetNode) return null;

  const from = boxOf(sourceNode);
  const to = boxOf(targetNode);

  const dx = to.centreX - from.centreX;
  const dy = to.centreY - from.centreY;

  // Concentric nodes leave no direction to draw in, and no line either.
  if (dx === 0 && dy === 0) return null;

  const start = exitAt(from, dx, dy);
  const end = exitAt(to, -dx, -dy);

  const [path] = getBezierPath({
    sourceX: start.x,
    sourceY: start.y,
    sourcePosition: start.position,
    targetX: end.x,
    targetY: end.y,
    targetPosition: end.position
  });

  return <BaseEdge path={path} />;
}

/**
 * Declared once, out here, for the same reason `GENERATION_NODE_TYPES` is:
 * React Flow compares this object by identity and rebuilds every edge type when
 * it changes.
 */
export const REFERENCE_EDGE_TYPES: EdgeTypes = { [REFERENCE_EDGE_TYPE]: ReferenceEdge };

/**
 * A reference line is a record, not a control: it is there because a generation
 * was made from that file, and there is nothing a person could mean by picking
 * one up. Deleting it is left possible — that is how React Flow takes an edge
 * away with the node it hangs off — but only ever as the consequence of
 * deleting a node, never as a click of its own. Being neither selectable nor
 * clickable is also what earns the `inactive` class React Flow answers with
 * `pointer-events: none`, so the twenty-unit-wide invisible hit path it draws
 * for every edge is not lying across the board taking presses.
 *
 * Hidden from assistive technology for want of anything true to say. React Flow
 * labels an edge "Edge from <id> to <id>", which on this canvas is two uuids
 * read aloud — and the thing actually worth announcing, that one result was
 * made from another, has no name here to announce it with: a title lives in a
 * node's data and an edge holds only ids. So the line says nothing rather than
 * saying that, and provenance stays a gap to fill on the nodes, where the names
 * are.
 *
 * All of it applied at render rather than written onto the stored edge, so the
 * document holds the graph and this holds the policy.
 */
export const REFERENCE_EDGE_OPTIONS: DefaultEdgeOptions = {
  selectable: false,
  focusable: false,
  domAttributes: { "aria-hidden": true }
};
