import type { NodeChange } from "@xyflow/react";
import { useState } from "react";

import {
  alignmentFor,
  resizeAlignmentFor,
  spacingFor
} from "#/components/block/studio/alignment-guides";
import type { Guides } from "#/components/block/studio/alignment-guides";
import { isVisual } from "#/components/block/studio/generation-node";
import type { GenerationNode } from "#/components/block/studio/generation-node";

/**
 * The snapping layer between React Flow and whatever actually stores the nodes.
 *
 * It owns the guides being drawn and nothing else: every change still flows to
 * `apply` exactly once, corrected where a drag or resize came close enough to
 * something worth meeting. Extracted from the canvas component so the canvas
 * can swap what `apply` writes to — local state, a shared document — without
 * the snapping caring.
 */
export function useSnapGuides(
  nodes: GenerationNode[],
  apply: (changes: NodeChange<GenerationNode>[]) => void
) {
  const [guides, setGuides] = useState<Guides>({});

  /**
   * A drag goes exactly where it is taken, unless it comes close enough to
   * something worth meeting — then it is pulled the last few pixels and a guide
   * is drawn to say why.
   *
   * Two things count as worth meeting, asked in that order. An edge lining up
   * with a neighbour's is the more specific of the two, so it is offered first
   * and keeps whichever axes it claims; the gap to a neighbour coming out equal
   * to a gap already on the canvas is offered on the axes it left alone. In a row
   * of nodes those are usually different axes — flush along one, evenly spaced
   * along the other — so both answer at once rather than taking turns.
   *
   * Nothing else moves it. There is no grid to land on, which is also what makes
   * the guides useful: on a quantised canvas a node is never a few pixels short
   * of lining up, so the pull would have nothing to do and the guide would only
   * ever appear once you had already arrived.
   */
  function onNodesChange(changes: NodeChange<GenerationNode>[]) {
    if (handleResize(changes)) return;

    const [change] = changes;

    // Anything that is not one node being dragged goes through untouched: a
    // selection, a nudge from the keyboard, several nodes at once. `dragging` is
    // the tell — React Flow sets it on the changes a drag emits and leaves it
    // off everything else.
    if (
      changes.length !== 1 ||
      change.type !== "position" ||
      !change.position ||
      change.dragging === undefined
    ) {
      setGuides({});
      apply(changes);

      return;
    }

    const alignment = alignmentFor(change, nodes);
    const spacing = spacingFor(change, nodes, alignment);

    /*
     * The guides belong to the drag and leave with it. The snap does not, and
     * this is why the last change of a drag is corrected like all the others
     * rather than waved through: React Flow works a drag out from the pointer
     * alone and never hears about the corrections, so it signs off with one
     * final change carrying the position it had in mind all along. Passed on as
     * it stands, that change is the node springing back the few pixels it was
     * just pulled — every guide shown during the drag, then quietly taken back
     * on release.
     */
    setGuides(
      change.dragging
        ? {
            vertical: alignment.vertical,
            horizontal: alignment.horizontal,
            spans: spacing.spans
          }
        : {}
    );
    apply([
      {
        ...change,
        position: {
          x: alignment.position.x ?? spacing.position.x ?? change.position.x,
          y: alignment.position.y ?? spacing.position.y ?? change.position.y
        }
      }
    ]);
  }

  /**
   * The resize half of the same idea: an edge pulled close to a neighbour's is
   * taken the rest of the way, and a guide is drawn to say which edge it met.
   *
   * A resize arrives as a pair rather than as one change — the new size always,
   * and a new position as well whenever the corner being pulled is not the
   * bottom-right one — so it is picked out and rewritten here instead of going
   * through the single-change path above. Returns whether it took the changes.
   */
  function handleResize(changes: NodeChange<GenerationNode>[]) {
    const resize = changes.find((change) => change.type === "dimensions" && change.resizing);

    if (resize?.type !== "dimensions" || !resize.dimensions) return false;

    const node = nodes.find((current) => current.id === resize.id);

    if (!node) return false;

    const moved = changes.find(
      (change) => change.type === "position" && change.id === resize.id && change.position
    );

    const next = {
      position: (moved?.type === "position" && moved.position) || node.position,
      width: resize.dimensions.width,
      height: resize.dimensions.height
    };

    const aligned = resizeAlignmentFor(node, next, nodes, isVisual(node.data));

    const position = aligned.position ?? next.position;
    const size = aligned.size ?? { width: next.width, height: next.height };

    setGuides({ vertical: aligned.vertical, horizontal: aligned.horizontal });
    apply(
      changes.map((change) => {
        // `type` is checked before `id` because not every kind of change has
        // one — an added node carries the whole node instead.
        if (change.type === "position" && change.id === resize.id) {
          return { ...change, position };
        }
        if (change.type === "dimensions" && change.id === resize.id) {
          return { ...change, dimensions: size };
        }

        return change;
      })
    );

    return true;
  }

  return { guides, onNodesChange };
}
