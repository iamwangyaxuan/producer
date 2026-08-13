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
import type { NodeChange } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent as ReactMouseEvent, PointerEvent } from "react";

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
import { useUploads } from "#/components/block/studio/use-uploads";
import { useViewportMemory } from "#/components/block/studio/use-viewport-memory";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";
import { ALLOWED_MIME, kindFromMime, MAX_BYTES } from "#/lib/asset-constraints";
import { deleteAsset } from "#/lib/assets";
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

/**
 * What the file picker offers up front. The same allowlist the server enforces,
 * so the dialog steers toward files that can actually land — it is a courtesy
 * filter, not a gate; `ingestFiles` still checks whatever comes through.
 */
const UPLOAD_ACCEPT = Object.values(ALLOWED_MIME).flat().join(",");

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
  const uploads = useUploads();
  const collab = useCanvasCollab({
    projectId,
    user: me,
    // Two kinds of in-flight work hang off pending nodes now, and the canvas
    // has one question for both: whose is it, and can it be called off.
    onNodesRemoved: (ids) => {
      generations.cancel(ids);
      uploads.cancel(ids);
    },
    isGenerating: (id) => generations.owns(id) || uploads.owns(id)
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

    if (id) void generations.start(id, projectId, submission, collab.patchNodeData);
  }

  /**
   * The picture's own proportions, so the skeleton that appears at the drop is
   * already the shape the image will fill. A file that cannot be decoded
   * falls back to a square rather than failing the upload — the server never
   * needed the ratio, only the node did.
   */
  async function imageRatio(file: File) {
    try {
      const bitmap = await createImageBitmap(file);
      const ratio = `${bitmap.width}:${bitmap.height}`;

      bitmap.close();

      return ratio;
    } catch {
      return undefined;
    }
  }

  /**
   * Files entering the canvas, wherever they came in — a drop or the context
   * menu's picker land on the same path.
   */
  async function ingestFiles(files: File[], origin: { x: number; y: number }) {
    let placed = 0;

    for (const file of files) {
      const kind = kindFromMime(file.type);

      // The same rules the server would answer 400/413 with, applied before a
      // request exists to refuse: a file of the wrong type or size never
      // leaves the machine.
      if (!kind || file.size > MAX_BYTES[kind]) continue;

      const aspectRatio =
        kind === "image" ? await imageRatio(file) : kind === "video" ? "16:9" : undefined;

      const id = collab.addGeneration(
        {
          modality: kind,
          // The filename is what the node has to say for itself — it feeds
          // the alt text and the audio row's label the way a prompt does.
          prompt: file.name,
          model: "",
          aspectRatio,
          status: "pending",
          source: "upload",
          generatedBy: collab.clientId ?? undefined
        },
        // Fan a multi-file batch out along a diagonal instead of burying
        // every file in the same free slot hunt from one anchor.
        { x: origin.x + placed * 24, y: origin.y + placed * 24 }
      );

      placed += 1;

      if (id) void uploads.start(id, projectId, file, kind, collab.patchNodeData);
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();

    const files = Array.from(event.dataTransfer.files);

    if (files.length === 0) return;

    void ingestFiles(files, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  function handleDragOver(event: DragEvent) {
    // Without this the browser navigates to the dropped file instead of
    // handing it to the canvas.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  /**
   * Where the canvas menu is open, in both coordinate systems at once: the
   * screen point anchors the popup, and the flow point — captured at the
   * right-click, not when the picker finally answers — is where chosen files
   * will land, however far the camera has moved in between.
   */
  const [canvasMenu, setCanvasMenu] = useState<{
    screen: { x: number; y: number };
    flow: { x: number; y: number };
  } | null>(null);

  /**
   * Carried from the menu click to the picker's answer in a ref, because the
   * menu state is long closed — and cleared — by the time a file dialog
   * resolves.
   */
  const uploadOrigin = useRef<{ x: number; y: number } | null>(null);

  const filePicker = useRef<HTMLInputElement>(null);

  const menuPopup = useRef<HTMLDivElement>(null);

  /**
   * Dismissal, owned here rather than left to Base UI: a menu opened by a
   * trigger gets outside-press and Escape handling from the interactions the
   * trigger wires up, but this one is opened by decree — `open` flipped on a
   * pane right-click — and in that detached configuration none of those
   * listeners exist (verified, not assumed). The capture phase sees a press
   * before anything can swallow it, and the opening right-click cannot
   * self-dismiss because these listeners only attach after it has run. A
   * second right-click on the pane lands here first, closes this menu, and
   * then reopens it at the new point.
   */
  useEffect(() => {
    if (!canvasMenu) return;

    function onPointerDown(event: globalThis.PointerEvent) {
      if (!menuPopup.current?.contains(event.target as Node)) setCanvasMenu(null);
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setCanvasMenu(null);
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);

    // Focus after the portal has painted, so the keyboard talks to the menu
    // rather than to whatever the right-click left focused.
    const frame = requestAnimationFrame(() => menuPopup.current?.focus());

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      cancelAnimationFrame(frame);
    };
  }, [canvasMenu]);

  function handlePaneContextMenu(event: ReactMouseEvent | globalThis.MouseEvent) {
    // The browser's own menu has nothing to say about a canvas.
    event.preventDefault();

    const point = { x: event.clientX, y: event.clientY };

    setCanvasMenu({ screen: point, flow: screenToFlowPosition(point) });
  }

  function pickFilesToUpload() {
    uploadOrigin.current = canvasMenu?.flow ?? null;
    // Closed here, deterministically, for the same reason dismissal is owned
    // above — and before the picker opens, so the modal file dialog is not
    // sitting on top of a menu that no longer means anything.
    setCanvasMenu(null);
    filePicker.current?.click();
  }

  /**
   * A node removed *here* takes its stored file with it: the delete button and
   * the delete key both arrive as `remove` changes, and only on the machine
   * that pressed them — unlike the collab layer's removal callback, which
   * fires on every open tab and would send one delete per bystander. The
   * asset delete is fire-and-forget: the server tombstones the row before
   * touching R2, so a lost request leaves bytes a sweep can still find, and
   * an already-deleted asset just answers not-found.
   */
  function handleNodesChange(changes: NodeChange<GenerationNode>[]) {
    for (const change of changes) {
      if (change.type !== "remove") continue;

      const assetId = collab.nodes.find((node) => node.id === change.id)?.data.assetId;

      if (assetId) void deleteAsset({ data: { id: assetId } }).catch(() => {});
    }

    snap.onNodesChange(changes);
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
          // The wheel follows the same modifier the drag does. At rest it
          // moves the camera — panning is the constant gesture on a board,
          // and a wheel that zooms by default keeps yanking the world out
          // from under the pointer. With space down the wheel zooms instead:
          // space already means "move things around", and scale is the one
          // camera move a plain wheel cannot make.
          panOnScroll={!dragMode}
          zoomOnScroll={dragMode}
          // React Flow's own space-bar shortcut, switched off by name: its
          // default `panActivationKeyCode` is Space, and while that key is
          // down it forces `panOnScroll` back on — quietly overriding the
          // two props above and turning the drag-mode wheel back into a pan.
          // This canvas already gives the space bar its meaning itself.
          panActivationKeyCode={null}
          // A double-click is a gesture nodes get to mean things with (and
          // misfire on — two fast clicks on a video's transport); the camera
          // lurching in on every one made it unusable for both.
          zoomOnDoubleClick={false}
          nodes={collab.nodes}
          edges={collab.edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={collab.applyEdgesChange}
          onConnect={collab.connect}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onPaneContextMenu={handlePaneContextMenu}
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

        {/* Detached from any trigger: the pane's right-click is the trigger,
          and the popup anchors to the point it happened at. The flow position
          was captured then too, so the menu can close — and the camera move —
          without the eventual files losing their place. */}
        <Menu.Root
          open={canvasMenu !== null}
          onOpenChange={(open) => {
            if (!open) setCanvasMenu(null);
          }}
        >
          <Menu.Content
            ref={menuPopup}
            positioner={{
              sideOffset: 0,
              anchor: canvasMenu
                ? {
                    getBoundingClientRect: () =>
                      DOMRect.fromRect({ x: canvasMenu.screen.x, y: canvasMenu.screen.y })
                  }
                : undefined
            }}
          >
            <Menu.Item onClick={pickFilesToUpload}>
              <Icon name="upload_file" className="text-sm text-neutral-400" />
              Upload files
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>

        {/* The picker the menu item reaches for. `accept` mirrors the server's
          allowlist as a courtesy; the change handler still validates. Resetting
          `value` lets the same file be chosen twice in a row. */}
        <input
          ref={filePicker}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);

            event.currentTarget.value = "";

            const origin =
              uploadOrigin.current ??
              screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

            uploadOrigin.current = null;

            if (files.length > 0) void ingestFiles(files, origin);
          }}
        />
      </main>
    </DragModeContext>
  );
}
