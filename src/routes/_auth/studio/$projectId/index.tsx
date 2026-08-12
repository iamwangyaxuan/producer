import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow
} from "@xyflow/react";
import type { Connection, Edge, NodeChange } from "@xyflow/react";
import { useRef, useState } from "react";

import AIComposer from "#/components/block/ai-composer";
import type { ComposerSubmission } from "#/components/block/ai-composer";
import AlignmentGuides, {
  alignmentFor,
  resizeAlignmentFor,
  spacingFor
} from "#/components/block/alignment-guides";
import type { Guides } from "#/components/block/alignment-guides";
import { freePosition, tidyPositions } from "#/components/block/canvas-placement";
import {
  DragModeContext,
  GENERATION_NODE_TYPES,
  isVisual,
  nodeSize
} from "#/components/block/generation-node";
import type { GenerationNode } from "#/components/block/generation-node";
import StudioToolbar from "#/components/block/studio-toolbar";
import { useDragMode } from "#/components/block/use-drag-mode";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import { projectQueryOptions } from "#/lib/projects";
import { requestGeneration } from "#/lib/sample-media";

export const Route = createFileRoute("/_auth/studio/$projectId/")({
  component: RouteComponent
});

/**
 * The provider is what lets the canvas be driven from the component that also
 * renders it: `screenToFlowPosition` needs the instance, and a new node should
 * land where the person is looking rather than at the origin of a canvas they
 * may have panned away from.
 */
function RouteComponent() {
  return (
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>
  );
}

/**
 * Texture, not a target. Nodes are placed and dragged freely; the dots are here
 * to give the canvas a sense of scale and movement while panning, and nothing
 * lines up with them.
 */
const DOT_SPACING = 16;

const INITIAL_NODES: GenerationNode[] = [];

const INITIAL_EDGES: Edge[] = [];

function Studio() {
  const { projectId } = Route.useParams();
  const { session } = Route.useRouteContext();

  /**
   * The layout route's loader has already resolved this exact key, so the
   * suspense flavour never actually suspends here — it is used for the promise
   * it makes about `data` instead. The read is live rather than taken from the
   * loader because a rename invalidates the query, not the loader: reading the
   * cache is what lets the strip show the new name the moment it lands.
   *
   * It can still go `null`, and briefly does: deleting the project refetches
   * this key before the navigation away has finished.
   */
  const { data: project } = useSuspenseQuery(
    projectQueryOptions(session.session.activeOrganizationId, projectId)
  );

  // `name` is NOT NULL but nothing stops it being whitespace, and a toolbar
  // with nothing in it is a toolbar nobody can find.
  const projectName = project?.name.trim() || "Untitled project";

  const { screenToFlowPosition } = useReactFlow<GenerationNode>();

  const [nodes, setNodes, onNodesChange] = useNodesState<GenerationNode>(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(INITIAL_EDGES);
  const [guides, setGuides] = useState<Guides>({});

  const dragMode = useDragMode();

  /** One per request still in flight, so deleting a node can call off its work. */
  const inFlight = useRef(new Map<string, AbortController>());
  const created = useRef(0);

  function patch(id: string, data: Partial<GenerationNode["data"]>) {
    setNodes((current) =>
      current.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...data } } : node))
    );
  }

  async function generate(submission: ComposerSubmission) {
    const id = `generation-${created.current++}`;

    const data: GenerationNode["data"] = {
      modality: submission.modality,
      prompt: submission.text,
      model: submission.model,
      aspectRatio: submission.aspectRatio,
      status: "pending"
    };

    const size = nodeSize(data);
    const centre = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    });

    setNodes((current) => [
      ...current,
      {
        id,
        type: "generation",
        // Written on the node rather than left to CSS: these are what the resize
        // controls change, and a node with no dimensions of its own has nothing
        // for them to take hold of.
        width: size.width,
        height: size.height,
        // Worked out inside the updater rather than before it: `current` is the
        // only list guaranteed to hold nodes added a moment ago, and two
        // submissions in quick succession would otherwise both be placed against
        // the canvas as it stood before either of them existed.
        position: freePosition(
          { x: centre.x - size.width / 2, y: centre.y - size.height / 2 },
          size,
          current
        ),
        data
      }
    ]);

    const controller = new AbortController();
    inFlight.current.set(id, controller);

    try {
      const src = await requestGeneration(submission, controller.signal);

      patch(id, { src, status: "ready" });
    } catch {
      // A cancelled request belongs to a node that is already gone; marking it
      // failed would be describing something nobody can see.
      if (!controller.signal.aborted) patch(id, { status: "failed" });
    } finally {
      inFlight.current.delete(id);
    }
  }

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
  function handleNodesChange(changes: NodeChange<GenerationNode>[]) {
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
      onNodesChange(changes);

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
    onNodesChange([
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
    onNodesChange(
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

  function tidy() {
    setNodes((current) => {
      const layout = tidyPositions(current);

      return current.map((node) => ({ ...node, position: layout.get(node.id) ?? node.position }));
    });
  }

  function onConnect(connection: Connection) {
    setEdges((current) => addEdge(connection, current));
  }

  return (
    // Above `ReactFlow`, so it reaches the nodes it renders: each one uses it to
    // decide whether hovering should offer to move it.
    <DragModeContext value={dragMode}>
      <main className="h-svh">
        <ReactFlow
          // Also what React Flow reads to swap in its own grab and grabbing
          // cursors, so the pointer follows the mode without being told twice.
          panOnDrag={dragMode}
          nodesDraggable={dragMode}
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodesDelete={(deleted) => {
            for (const node of deleted) {
              inFlight.current.get(node.id)?.abort();
              inFlight.current.delete(node.id);
            }
          }}
          nodeTypes={GENERATION_NODE_TYPES}
          colorMode="dark"
          aria-label="Canvas"
        >
          <Background variant={BackgroundVariant.Dots} gap={DOT_SPACING} size={1} />

          <AlignmentGuides {...guides} />

          <Panel position="top-left" className="m-0 p-6">
            <StudioToolbar projectId={projectId} name={projectName}>
              {/* Nothing to tidy until there are two things to put in order, so
                the control stays out of the way until it would do something.
                It sits inside the strip rather than beside it because there is
                only one top-left corner, and two panels claiming it would land
                on top of each other. */}
              {nodes.length > 1 ? (
                <Button icon variant="ghost" size="md" aria-label="Tidy up" onClick={tidy}>
                  <Icon name="grid_view" className="text-base" />
                </Button>
              ) : null}
            </StudioToolbar>
          </Panel>

          {/* Full-width but pointer-transparent, so the composer can sit centred
            without the strip around it taking every drag along the bottom of the
            canvas with it. */}
          <Panel position="bottom-left" className="pointer-events-none m-0 w-full">
            <div className="px-6 pb-6">
              <AIComposer
                className="pointer-events-auto mx-auto w-full max-w-2xl"
                onSubmit={(submission) => void generate(submission)}
              />
            </div>
          </Panel>
        </ReactFlow>
      </main>
    </DragModeContext>
  );
}
