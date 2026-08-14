import type { XYPosition } from "@xyflow/react";

import { NODE_WIDTH, nodeSize } from "#/components/block/studio/generation-node";
import type { GenerationNodeData } from "#/components/block/studio/generation-node";

export interface Size {
  width: number;
  height: number;
}

/**
 * The little a node has to be to be placed: somewhere it is, something about
 * how big it is. Structural rather than React Flow's node type so the shared
 * document's stored records — which carry geometry but keep `data` in a
 * separate map — can be placed against directly.
 */
export interface Placeable {
  id: string;
  position: XYPosition;
  width?: number | null;
  height?: number | null;
  measured?: { width?: number; height?: number };
  data?: GenerationNodeData;
}

/** Space left between neighbours, so "free" does not come out meaning "touching". */
const GUTTER = 32;

/**
 * How far out to look before giving up. Twenty-four rings of node-sized cells is
 * a canvas nobody has filled by hand; the bound is here so a bug upstream cannot
 * turn this into a loop that never ends.
 */
const MAX_RINGS = 24;

interface Cell {
  col: number;
  row: number;
}

function overlaps(a: XYPosition, aSize: Size, b: XYPosition, bSize: Size) {
  return (
    a.x < b.x + bSize.width &&
    a.x + aSize.width > b.x &&
    a.y < b.y + bSize.height &&
    a.y + aSize.height > b.y
  );
}

/**
 * Three places a size can come from, in order of how current they are: what the
 * browser last measured, what a resize wrote onto the node, and — for a node
 * added in this very tick, which has neither — what its ratio says it will be.
 */
export function sizeOf(node: Placeable): Size {
  const measured = node.measured;

  if (measured?.width && measured.height) return { width: measured.width, height: measured.height };
  if (node.width && node.height) return { width: node.width, height: node.height };

  // A stored record always carries its dimensions, so this last resort only
  // exists for a node manufactured somewhere new — and even then a square of
  // the standard width beats a zero-sized box everything lands on top of.
  return node.data ? nodeSize(node.data) : { width: NODE_WIDTH, height: NODE_WIDTH };
}

/**
 * Candidate slots, nearest ring first.
 *
 * Within a ring the order is the one a person filling a page would use: stay on
 * the same row if you can, go down before you go up, and go right before you go
 * left. Without that the first free slot is as likely to be up and to the left,
 * which reads as the canvas throwing work backwards.
 */
function* cells(): Generator<Cell> {
  yield { col: 0, row: 0 };

  for (let ring = 1; ring <= MAX_RINGS; ring++) {
    const ringCells: Cell[] = [];

    for (let row = -ring; row <= ring; row++) {
      for (let col = -ring; col <= ring; col++) {
        if (Math.max(Math.abs(col), Math.abs(row)) === ring) ringCells.push({ col, row });
      }
    }

    ringCells.sort(
      (a, b) =>
        Math.abs(a.row) - Math.abs(b.row) ||
        b.row - a.row ||
        Math.abs(a.col) - Math.abs(b.col) ||
        b.col - a.col
    );

    yield* ringCells;
  }
}

/**
 * Every coordinate on one axis at which a new node of `length` would line up
 * with an existing one of `extent` — sharing an edge, sharing a centre, or
 * sitting directly alongside with a gutter between.
 */
function alignedTo(near: number, far: number, length: number) {
  return [
    near, // near edges flush
    far - length, // far edges flush
    (near + far - length) / 2, // centres
    far + GUTTER, // alongside, after it
    near - length - GUTTER // alongside, before it
  ];
}

/** Bounded so a canvas of many nodes cannot turn this into a long search. */
const MAX_CANDIDATES = 600;

/**
 * The nearest spot to `anchor` where a node of `size` sits clear of everything
 * already on the canvas — and, wherever it can, lined up with it.
 *
 * The candidates are built from the edges of the nodes already there rather than
 * from a lattice, because there is no lattice: nodes sit wherever they were
 * dragged, aligned or resized to. Taking the coordinates off real neighbours is
 * what makes a new node share an edge with one instead of landing a few pixels
 * out from it, which is the kind of near-miss that has to be tidied by hand.
 *
 * The anchor's own coordinates are in the list too, so a clear spot right where
 * the person is looking still wins on distance and nothing is moved to line up
 * with something for the sake of it.
 */
export function freePosition(
  anchor: XYPosition,
  size: Size,
  taken: readonly Placeable[]
): XYPosition {
  const occupied = taken.map((node) => ({ position: node.position, size: sizeOf(node) }));
  const clear = (at: XYPosition) =>
    !occupied.some((other) => overlaps(at, size, other.position, other.size));

  // Somewhere clear to look at beats somewhere tidy: if the spot the person is
  // already looking at is free, nothing is moved to line up with anything.
  if (clear(anchor)) return { ...anchor };

  const xs = new Set<number>();
  const ys = new Set<number>();

  for (const { position, size: other } of occupied) {
    for (const x of alignedTo(position.x, position.x + other.width, size.width)) xs.add(x);
    for (const y of alignedTo(position.y, position.y + other.height, size.height)) ys.add(y);
  }

  const candidates: XYPosition[] = [];

  for (const x of [anchor.x, ...xs]) {
    for (const y of [anchor.y, ...ys]) candidates.push({ x, y });
  }

  /**
   * Distance from the anchor, less a credit for each axis that lines up.
   *
   * Distance alone is not enough: a spot three pixels off a neighbour's edge is
   * nearer than the edge itself and would win, leaving the new node almost
   * aligned — the near miss that has to be straightened by hand later. The
   * credit is worth more than that kind of gap and far less than a real detour,
   * so lining up wins the close calls and never drags a node across the canvas.
   */
  const ALIGNMENT_CREDIT = 24;

  const score = ({ x, y }: XYPosition) =>
    Math.hypot(x - anchor.x, y - anchor.y) -
    (xs.has(x) ? ALIGNMENT_CREDIT : 0) -
    (ys.has(y) ? ALIGNMENT_CREDIT : 0);

  candidates.sort((a, b) => score(a) - score(b));

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (clear(candidate)) return candidate;
  }

  // Nothing lined up and free, which takes a crowded canvas. Step out from the
  // anchor in whole node-and-gutter strides until there is room.
  for (const { col, row } of cells()) {
    const candidate = {
      x: anchor.x + col * (size.width + GUTTER),
      y: anchor.y + row * (size.height + GUTTER)
    };

    if (clear(candidate)) return candidate;
  }

  return { ...anchor };
}
