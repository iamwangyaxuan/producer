import { Toast } from "@base-ui/react/toast";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
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

import { ConfirmDialog } from "#/components/block/project-dialogs";
import AIComposer from "#/components/block/studio/ai-composer";
import type { ComposerHandle, ComposerSubmission } from "#/components/block/studio/ai-composer";
import AlignmentGuides from "#/components/block/studio/alignment-guides";
import {
  DragModeContext,
  GENERATION_NODE_TYPES,
  NodeActionsContext
} from "#/components/block/studio/generation-node";
import type {
  GenerationNode,
  GenerationNodeData,
  NodeActions
} from "#/components/block/studio/generation-node";
import PresenceAvatars from "#/components/block/studio/presence-avatars";
import PresenceCursors from "#/components/block/studio/presence-cursors";
import StudioToolbar, { ZoomLevel } from "#/components/block/studio/studio-toolbar";
import { useCanvasCollab } from "#/components/block/studio/use-canvas-collab";
import { useGenerations } from "#/components/block/studio/use-generations";
import { useSnapGuides } from "#/components/block/studio/use-snap-guides";
import { useUploads } from "#/components/block/studio/use-uploads";
import { useViewportMemory } from "#/components/block/studio/use-viewport-memory";
import Button from "#/components/ui/button";
import ContextMenu from "#/components/ui/context-menu";
import Icon from "#/components/ui/icon";
import { ALLOWED_MIME, kindFromMime, MAX_BYTES } from "#/lib/asset-constraints";
import { assetContentUrl } from "#/lib/asset-links";
import { deleteAsset, projectAssetsQueryOptions } from "#/lib/assets";
import type { AssetSummary } from "#/lib/assets";
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

  /**
   * The project's files. Not the canvas's — a node derives its URL from the id
   * it already holds — so this is an ordinary query and nothing waits on it.
   */
  const { data: assets } = useQuery(projectAssetsQueryOptions(projectId));

  const { screenToFlowPosition, deleteElements: deleteNodes } = useReactFlow<GenerationNode>();

  /**
   * Whatever the camera is pointed at right now — where a new result is born,
   * and where an upload lands when nothing else said. Read at the moment of
   * the gesture rather than tracked, so it follows a pan without a subscription.
   */
  const viewportCentre = () =>
    screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

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

  const toast = Toast.useToastManager();
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

  /**
   * What `@` can reach: the files that are actually on the board.
   *
   * The project's asset list is the wrong set on both sides. It is too large —
   * a file whose node was deleted still has a row, as does anything a
   * teammate's node used before they removed it, so the list fills up with
   * things nobody can point at. And it is ordered by row, so two nodes showing
   * the same file offered it twice. Reading the ids off the canvas fixes both:
   * the set is what is visible, and a set cannot repeat.
   *
   * Ordered by the asset list rather than by node, so the menu stays newest
   * first however the board is arranged.
   */
  const canvasAssetIds = useMemo(() => {
    const ids = new Set<string>();

    for (const node of collab.nodes) {
      if (node.data.assetId && node.data.status === "ready") ids.add(node.data.assetId);
    }

    return ids;
  }, [collab.nodes]);

  /**
   * Left `undefined` until the query has answered, rather than flattened to an
   * empty array. The composer prunes mentions of files that are no longer in
   * this list, so "not loaded yet" and "nothing is attachable" have to be
   * distinguishable — otherwise the first render of a reloaded page would read
   * as every file having been deleted.
   */
  const attachableAssets = useMemo(
    () => assets?.filter((asset) => canvasAssetIds.has(asset.id)),
    [assets, canvasAssetIds]
  );

  function generate(submission: ComposerSubmission) {
    const centre = viewportCentre();

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
    const rejected: { name: string; reason: string }[] = [];

    for (const file of files) {
      const kind = kindFromMime(file.type);

      // The same rules the server would answer 400/413 with, applied before a
      // request exists to refuse: a file of the wrong type or size never
      // leaves the machine. Refusals are collected rather than dropped —
      // a file that simply vanishes on landing reads as a broken canvas.
      if (!kind) {
        rejected.push({ name: file.name, reason: "unsupported type" });
        continue;
      }

      if (file.size > MAX_BYTES[kind]) {
        rejected.push({
          name: file.name,
          reason: `over the ${Math.round(MAX_BYTES[kind] / 1_000_000)} MB limit for ${kind}`
        });
        continue;
      }

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

    // One notice for the batch: dropping a folder of mixed files should not
    // put a card on screen per stray.
    if (rejected.length === 1) {
      toast.add({
        type: "error",
        title: `${rejected[0].name} was not added`,
        description: `It is ${rejected[0].reason}.`
      });
    } else if (rejected.length > 1) {
      toast.add({
        type: "error",
        title: `${rejected.length} files were not added`,
        description: rejected.map((entry) => `${entry.name} — ${entry.reason}`).join("; ")
      });
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
   * The node menu, and everything it needs decided at the moment of the
   * right-click rather than while it is open.
   *
   * `asset` and `attachable` in particular: the file behind a node is looked up
   * once here, and whether the chosen model would take it is asked of the
   * composer once here. Both are answered against what was true when the menu
   * opened, which is also the only state a menu should ever act on.
   */
  const [nodeMenu, setNodeMenu] = useState<{
    screen: { x: number; y: number };
    nodeId: string;
    data: GenerationNodeData;
    asset?: AssetSummary;
    attachable: boolean;
  } | null>(null);

  /** The node the delete item is asking about, once it has been confirmed. */
  const [deleting, setDeleting] = useState<{ id: string; hasFile: boolean } | null>(null);

  /**
   * Carried from the menu click to the picker's answer in a ref, because the
   * menu state is long closed — and cleared — by the time a file dialog
   * resolves.
   */
  const uploadOrigin = useRef<{ x: number; y: number } | null>(null);

  /** How the node menu reaches the composer — see `ComposerHandle`. */
  const composer = useRef<ComposerHandle>(null);

  const filePicker = useRef<HTMLInputElement>(null);

  function handlePaneContextMenu(event: ReactMouseEvent | globalThis.MouseEvent) {
    // The browser's own menu has nothing to say about a canvas.
    event.preventDefault();

    // The node menu, if one is up, is about something this press is not.
    // Said outright rather than left to the outside-press dismissal, which
    // holds off for a moment after opening so the press that opened a menu
    // cannot close it again — a right-click landing inside that window would
    // otherwise leave both menus on screen at once.
    setNodeMenu(null);

    const point = { x: event.clientX, y: event.clientY };

    setCanvasMenu({ screen: point, flow: screenToFlowPosition(point) });
  }

  function handleNodeContextMenu(event: ReactMouseEvent, node: GenerationNode) {
    event.preventDefault();
    // A right-click on a node is about that node; the pane's own menu would
    // otherwise open underneath this one.
    event.stopPropagation();

    setCanvasMenu(null);

    const asset = node.data.assetId
      ? assets?.find((entry) => entry.id === node.data.assetId)
      : undefined;

    setNodeMenu({
      screen: { x: event.clientX, y: event.clientY },
      nodeId: node.id,
      data: node.data,
      asset,
      // Two ways this is false, and the menu does not distinguish them: the
      // file is still arriving, or the chosen model does not take that kind of
      // input at all. Either way the item is there but inert, which says the
      // action exists without pretending it would work.
      attachable: asset !== undefined && (composer.current?.accepts(asset.kind) ?? false)
    });
  }

  function attachToPrompt() {
    const asset = nodeMenu?.asset;

    setNodeMenu(null);

    if (asset) composer.current?.attach(asset);
  }

  function downloadNode() {
    const data = nodeMenu?.data;

    setNodeMenu(null);

    if (!data?.assetId) return;

    const anchor = document.createElement("a");

    anchor.href = assetContentUrl(data.assetId, { download: true });
    anchor.rel = "noreferrer";
    anchor.download = "";
    anchor.click();
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

  /**
   * Everything a retry needs, read through a ref so the context value below can
   * be built once. It is handed to every node on the canvas, and a fresh object
   * each render would re-render all of them on every frame of a drag — for a
   * pair of callbacks nobody is pressing while dragging.
   */
  const retryTargets = useRef({ uploads, generations, patch: collab.patchNodeData, projectId });

  useEffect(() => {
    retryTargets.current = { uploads, generations, patch: collab.patchNodeData, projectId };
  }, [uploads, generations, collab.patchNodeData, projectId]);

  /**
   * Whether a failed node can be tried again is a question about this tab, not
   * about the node: an upload can only be retried where the file still is, and
   * after a reload that is nowhere. A generation can always be retried, because
   * the request it was made from is on the server.
   */
  const nodeActions = useMemo<NodeActions>(
    () => ({
      canRetry: (id, data) => {
        const { uploads, generations } = retryTargets.current;

        return data.source === "upload" ? uploads.canRetry(id) : generations.canRetry(data, id);
      },
      retry: (id, data) => {
        const { uploads, generations, patch, projectId } = retryTargets.current;

        if (data.source === "upload") void uploads.retry(id, patch);
        else void generations.retry(id, projectId, data, patch);
      }
    }),
    []
  );

  return (
    // Above `ReactFlow`, so it reaches the nodes it renders: each one uses it to
    // decide whether hovering should offer to move it.
    <DragModeContext value={dragMode}>
      <NodeActionsContext value={nodeActions}>
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
            onNodeContextMenu={handleNodeContextMenu}
            nodeTypes={GENERATION_NODE_TYPES}
            colorMode="dark"
            aria-label="Canvas"
          >
            <Background variant={BackgroundVariant.Dots} gap={DOT_SPACING} size={1} />

            <AlignmentGuides {...snap.guides} />

            <PresenceCursors peers={collab.peers} selfClientId={collab.clientId} />

            <Panel position="top-left" className="m-0 p-6">
              <StudioToolbar projectId={projectId} name={projectName}>
                {/* First, so the number keeps its place: the button beside it
                  comes and goes with the node count, and a reading that jumped
                  sideways whenever a second node landed would be a reading
                  nobody could glance at. */}
                <ZoomLevel />

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
                  ref={composer}
                  className="pointer-events-auto mx-auto w-full max-w-2xl"
                  assets={attachableAssets}
                  onSubmit={(submission) => void generate(submission)}
                />
              </div>
            </Panel>
          </ReactFlow>

          {/* No `Trigger` wrapping a region, because the region cannot be wrapped:
          React Flow owns the right-click, and it is what decides whether the
          press was on the pane or on a node — a question no DOM ancestry can
          answer, since a node sits inside the pane. So the press is reported
          here and handed back as a point, which is the one thing Base UI needs
          to place a context menu exactly as if it had caught the press itself.

          The flow position was captured at the same moment, so the menu can
          close — and the camera move — without the eventual files losing the
          place they were asked for. */}
          <ContextMenu.Root
            open={canvasMenu !== null}
            onOpenChange={(open) => {
              if (!open) setCanvasMenu(null);
            }}
          >
            <ContextMenu.Content point={canvasMenu?.screen}>
              <ContextMenu.Item onClick={pickFilesToUpload}>
                <Icon name="upload_file" className="text-sm" />
                Upload files
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>

          {/* The node's own menu, opened the same way as the pane's. */}
          <ContextMenu.Root
            open={nodeMenu !== null}
            onOpenChange={(open) => {
              if (!open) setNodeMenu(null);
            }}
          >
            <ContextMenu.Content point={nodeMenu?.screen}>
              <ContextMenu.Item disabled={!nodeMenu?.data.assetId} onClick={downloadNode}>
                <Icon name="download" className="text-sm" />
                Download
              </ContextMenu.Item>

              {/* Present but inert when the model cannot take this kind of file:
                the action is real and belongs to this node, and hiding it would
                make the menu's contents change shape with the model chosen two
                panels away. */}
              <ContextMenu.Item disabled={!nodeMenu?.attachable} onClick={attachToPrompt}>
                <Icon name="alternate_email" className="text-sm" />
                Add to prompt
              </ContextMenu.Item>

              <ContextMenu.Separator />

              {/* Only the label is red. The row's highlight stays neutral because
                overriding the menu's preset would be a specificity tie broken by
                whichever rule Tailwind happens to emit last. */}
              <ContextMenu.Item
                className="text-red-400"
                onClick={() => {
                  const target = nodeMenu;

                  setNodeMenu(null);

                  if (target) setDeleting({ id: target.nodeId, hasFile: !!target.data.assetId });
                }}
              >
                <Icon name="delete" className="text-sm" />
                Delete
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>

          <ConfirmDialog
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            title="Delete this result?"
            description={
              deleting?.hasFile
                ? "The file is removed from this project for everyone."
                : "The node is removed from the canvas for everyone."
            }
            confirmLabel="Delete"
            destructive
            // Nothing to report or wait for: removing the node is a local edit
            // the collaboration layer replicates, and the file it may own is
            // collected by the change handler above rather than awaited here.
            error={null}
            pending={false}
            onConfirm={() => {
              if (deleting) void deleteNodes({ nodes: [{ id: deleting.id }] });

              // Dismissed here rather than by the dialog, which leaves confirm
              // open on purpose so a slow or failed action can report itself.
              // The node's own copy of this dialog gets away without it only
              // because deleting the node unmounts the dialog with it; this one
              // lives on the canvas and would simply stay up.
              setDeleting(null);
            }}
          />

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

              const origin = uploadOrigin.current ?? viewportCentre();

              uploadOrigin.current = null;

              if (files.length > 0) void ingestFiles(files, origin);
            }}
          />
        </main>
      </NodeActionsContext>
    </DragModeContext>
  );
}
