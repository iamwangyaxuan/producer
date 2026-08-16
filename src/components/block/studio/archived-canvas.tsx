import { useSuspenseQuery } from "@tanstack/react-query";
import { Background, BackgroundVariant, Panel, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";

import {
  DragModeContext,
  GENERATION_NODE_TYPES,
  ReadOnlyContext
} from "#/components/block/studio/generation-node";
import {
  REFERENCE_EDGE_OPTIONS,
  REFERENCE_EDGE_TYPES
} from "#/components/block/studio/reference-edge";
import StudioToolbar, { ZoomLevel } from "#/components/block/studio/studio-toolbar";
import { dragModeProps, useDragMode } from "#/components/block/studio/use-drag-mode";
import { useViewportMemory } from "#/components/block/studio/use-viewport-memory";
import { canvasSnapshotQueryOptions, decodeCanvasSnapshot } from "#/lib/canvas-snapshot";

/**
 * An archived project's canvas: the same board, with nothing to do to it.
 *
 * A separate component rather than a `readOnly` branch threaded through the
 * live one, and that is the point. The editor is ~800 lines of things that
 * write — the composer, uploads, drops, both context menus, the delete dialog,
 * the snap layer, presence, the collaboration socket — and a mode flag through
 * all of it would mean every one of those stayed on screen wearing a `disabled`
 * prop, with the next edit affordance anyone adds arriving switched on by
 * default. Here they are not disabled; they do not exist. What is on screen is
 * everything this component can do.
 *
 * There is no socket either, which is what makes read-only real rather than
 * polite: `canAccessProjectCanvas` still refuses an archived project, so the
 * Durable Object holding the writable document is not reachable from this page
 * at all. The board comes from the snapshot the room last saved — see
 * `lib/canvas-snapshot.ts`.
 */

/** The same texture the live canvas has; nothing lines up with it there either. */
const DOT_SPACING = 16;

export interface ArchivedCanvasProps {
  projectId: string;
  /** Already resolved by the caller, including the fallback for a blank name. */
  projectName: string;
}

export default function ArchivedCanvas({ projectId, projectName }: ArchivedCanvasProps) {
  const { data: snapshot } = useSuspenseQuery(canvasSnapshotQueryOptions(projectId));

  // Decoded once per payload. The document does not change under a reader, so
  // there is nothing to subscribe to and no reason to hold Yjs structures open.
  const { nodes, edges } = useMemo(() => decodeCanvasSnapshot(snapshot), [snapshot]);

  // The same space-bar gesture the editor has. Read-only does not make the
  // canvas a different *kind* of surface, and a viewer where the pointer means
  // something else — a permanent grab hand, a wheel that zooms — is a second
  // set of habits for the same board.
  const dragMode = useDragMode();

  // Kept, and worth keeping: where somebody left the camera is as useful on a
  // board they are reading as on one they are building, and it is the one piece
  // of canvas state that was never in the document anyway.
  useViewportMemory(projectId);

  return (
    <ReadOnlyContext value={true}>
      {/* Above `ReactFlow`, so it reaches the nodes it renders: each one uses it
          to decide whether hovering should offer to move it — which here it
          never will, but the cursor has to agree with that rather than promise
          a grab the board does not honour. */}
      <DragModeContext value={dragMode}>
        <main className="h-svh">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={GENERATION_NODE_TYPES}
            edgeTypes={REFERENCE_EDGE_TYPES}
            defaultEdgeOptions={REFERENCE_EDGE_OPTIONS}
            /*
             * Nothing can be moved, connected or removed. With no
             * `onNodesChange` React Flow treats these as uncontrolled, so a
             * drag it did allow would move a node in its own store and quietly
             * disagree with the document nobody is writing.
             *
             * `deleteKeyCode` explicitly null — the default is Backspace and
             * Delete, and a selected node plus a stray keypress is exactly the
             * accident this page must not have.
             *
             * `elementsSelectable` stays **on**, and it is not an oversight.
             * React Flow gives a node `pointer-events: none` unless it is
             * selectable, draggable, or carries a mouse handler — so turning it
             * off made every node click-through, and a video's transport and an
             * audio node's play button stopped answering. Selection is the
             * cheapest way to keep those alive and costs nothing here: with the
             * delete key disarmed there is nothing a selected node can be made
             * to do.
             */
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            deleteKeyCode={null}
            {...dragModeProps(dragMode)}
            colorMode="dark"
            aria-label={`Canvas (archived): ${projectName}`}
          >
            <Background variant={BackgroundVariant.Dots} gap={DOT_SPACING} size={1} />

            <Panel position="top-left" className="m-0 p-6">
              <StudioToolbar projectId={projectId} name={projectName} readOnly>
                <ZoomLevel />
              </StudioToolbar>
            </Panel>

            {/* No presence corner: nobody is "in" an archived project, and an
                empty avatar stack is a promise that somebody might turn up. */}
          </ReactFlow>
        </main>
      </DragModeContext>
    </ReadOnlyContext>
  );
}
