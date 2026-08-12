import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useKeyPress,
  useReactFlow
} from "@xyflow/react";
import { useEffect, useMemo } from "react";
import type { PointerEvent } from "react";

import AIComposer from "#/components/block/studio/ai-composer";
import type { ComposerSubmission } from "#/components/block/studio/ai-composer";
import AlignmentGuides from "#/components/block/studio/alignment-guides";
import { DragModeContext, GENERATION_NODE_TYPES } from "#/components/block/studio/generation-node";
import type { GenerationNode } from "#/components/block/studio/generation-node";
import PresenceAvatars from "#/components/block/studio/presence-avatars";
import PresenceCursors from "#/components/block/studio/presence-cursors";
import StudioToolbar from "#/components/block/studio/studio-toolbar";
import { useCanvasCollab } from "#/components/block/studio/use-canvas-collab";
import { useGenerations } from "#/components/block/studio/use-generations";
import { useSnapGuides } from "#/components/block/studio/use-snap-guides";
import { useViewportMemory } from "#/components/block/studio/use-viewport-memory";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import { presenceColor } from "#/lib/canvas/presence";
import { projectQueryOptions } from "#/lib/projects";

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

  /**
   * Whether the space bar is being held, which is what puts the canvas into
   * its move-things-around mode: panning and node dragging both wait for it,
   * so a stray drag cannot shove the work about. React Flow's own hook rather
   * than a hand-rolled listener — it already ignores typing in inputs,
   * prevents the page scroll, and lets go when the window loses focus.
   */
  const dragMode = useKeyPress("Space");

  /**
   * The one thing the hook deliberately does not do: on a focused button it
   * leaves the browser's default alone, so the space bar would *both* enter
   * drag mode and — on release — press the button. On this canvas that pairing
   * is never meant: someone who has just clicked "Tidy up" and holds space to
   * move a node would rearrange everyone's board again on letting go. Space
   * activates buttons on keyup, so dropping focus on keydown is enough.
   */
  useEffect(() => {
    if (!dragMode) return;

    const active = document.activeElement;

    if (active instanceof HTMLElement && (active.tagName === "BUTTON" || active.tagName === "A")) {
      active.blur();
    }
  }, [dragMode]);

  /** Who this tab is, to everyone else on the canvas. */
  const me = useMemo(
    () => ({
      id: session.user.id,
      name: session.user.name,
      image: session.user.image ?? null,
      color: presenceColor(session.user.id)
    }),
    [session.user.id, session.user.name, session.user.image]
  );

  const generations = useGenerations();
  const collab = useCanvasCollab({
    projectId,
    user: me,
    onNodesRemoved: generations.cancel,
    isGenerating: generations.owns
  });
  const snap = useSnapGuides(collab.nodes, collab.applyNodesChange);

  useViewportMemory(projectId);

  function generate(submission: ComposerSubmission) {
    const centre = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    });

    const id = collab.addGeneration(
      {
        modality: submission.modality,
        prompt: submission.text,
        model: submission.model,
        aspectRatio: submission.aspectRatio,
        status: "pending",
        generatedBy: collab.clientId ?? undefined
      },
      centre
    );

    if (id) void generations.start(id, submission, collab.patchNodeData);
  }

  /**
   * The pointer is reported in flow coordinates so every other zoom level and
   * camera position draws it in the right place. On the wrapper rather than a
   * React Flow pane handler, because the pane goes quiet while a node is being
   * dragged — exactly when everyone else most wants to see the cursor moving.
   */
  function shareCursor(event: PointerEvent) {
    collab.setCursor(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  return (
    // Above `ReactFlow`, so it reaches the nodes it renders: each one uses it to
    // decide whether hovering should offer to move it.
    <DragModeContext value={dragMode}>
      <main
        className="h-svh"
        onPointerMove={shareCursor}
        onPointerLeave={() => collab.setCursor(null)}
      >
        <ReactFlow
          // Also what React Flow reads to swap in its own grab and grabbing
          // cursors, so the pointer follows the mode without being told twice.
          panOnDrag={dragMode}
          nodesDraggable={dragMode}
          nodes={collab.nodes}
          edges={collab.edges}
          onNodesChange={snap.onNodesChange}
          onEdgesChange={collab.applyEdgesChange}
          onConnect={collab.connect}
          nodeTypes={GENERATION_NODE_TYPES}
          colorMode="dark"
          aria-label="Canvas"
        >
          <Background variant={BackgroundVariant.Dots} gap={DOT_SPACING} size={1} />

          <AlignmentGuides {...snap.guides} />

          <PresenceCursors peers={collab.peers} selfClientId={collab.clientId} />

          <Panel position="top-left" className="m-0 p-6">
            <StudioToolbar projectId={projectId} name={projectName}>
              {/* Nothing to tidy until there are two things to put in order, so
                the control stays out of the way until it would do something.
                It sits inside the strip rather than beside it because there is
                only one top-left corner, and two panels claiming it would land
                on top of each other. */}
              {collab.nodes.length > 1 ? (
                <Button icon variant="ghost" size="md" aria-label="Tidy up" onClick={collab.tidy}>
                  <Icon name="grid_view" className="text-base" />
                </Button>
              ) : null}
            </StudioToolbar>
          </Panel>

          {/* Who else is here, in the corner every design tool keeps it in. */}
          <Panel position="top-right" className="m-0 p-6">
            <PresenceAvatars peers={collab.peers} />
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
