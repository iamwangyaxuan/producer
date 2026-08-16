import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useReactFlow, useStore } from "@xyflow/react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ConfirmDialog, RenameDialog } from "#/components/block/project-dialogs";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";
import { useDeleteProject, useRenameProject } from "#/lib/projects";

export interface StudioToolbarProps {
  projectId: string;
  /** Already resolved by the caller, including the fallback for a blank name. */
  name: string;
  /**
   * An archived project. The menu keeps only the way out, and the strip says so
   * out loud — a canvas that silently refuses everything reads as broken, while
   * one wearing the word "Archived" reads as finished.
   */
  readOnly?: boolean;
  /** Canvas controls that belong on the same strip; separated when present. */
  children?: ReactNode;
}

/**
 * The strip in the canvas's top-left corner: which project this is, and what can
 * be done to it.
 *
 * A menu rather than a row of buttons because the canvas *is* the screen.
 * Anything parked on it permanently is covering the work, so the strip shows
 * only the one thing worth reading at a glance — the name — and keeps every
 * action one press behind it.
 *
 * It borrows the menus' own surface (the same translucent fill, radius and
 * blur), so the popup reads as the strip unfolding rather than as a second
 * panel arriving from somewhere else.
 */
export default function StudioToolbar({
  projectId,
  name,
  readOnly = false,
  children
}: StudioToolbarProps) {
  return (
    <div className="flex items-center gap-1 rounded-[18px] bg-[rgba(22,23,24,0.9)] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl">
      <ProjectMenu projectId={projectId} name={name} readOnly={readOnly} />
      {/* Beside the name, not somewhere else on the canvas: the question it
          answers — why is there nothing to do here — is asked *of the project*,
          and this strip is where the project is named. */}
      {readOnly ? (
        <span className="mr-1 shrink-0 rounded-md bg-[rgba(218,220,224,0.08)] px-2 py-0.5 text-[11px] leading-4 text-neutral-300">
          Archived
        </span>
      ) : null}
      {children ? (
        <>
          <ToolbarSeparator />
          {children}
        </>
      ) : null}
    </div>
  );
}

/**
 * Shows and hides the prompt box along the bottom of the canvas.
 *
 * It earns its permanent place on the strip by being the one control that gives
 * the board back: the composer is the largest thing standing on the canvas, and
 * the reason to hide it — looking at what has been made, without a panel across
 * the bottom of it — is exactly the moment when hunting through a menu for the
 * way to do that is most annoying.
 *
 * The icon names the panel rather than the chat: `bottom_panel_close` while it
 * is up, `bottom_panel_open` once it is down, so the glyph is always the thing
 * the press will do — which is also what the label says, and why there is no
 * `aria-pressed` on top of it. Two ways of saying the same state, one of which
 * would be read out as a toggle whose "on" is ambiguous, is worse than one.
 */
export function ComposerToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      icon
      variant="ghost"
      size="md"
      aria-label={open ? "Hide the prompt box" : "Show the prompt box"}
      onClick={onToggle}
    >
      <Icon name={open ? "bottom_panel_close" : "bottom_panel_open"} className="text-base" />
    </Button>
  );
}

/** Every step lands on a multiple of this, so the reading is always a round number. */
const ZOOM_STEP = 0.05;

/**
 * Float slack. `1 / 0.05` is `20.000000000000004`, and without a nudge a press
 * at exactly 100% would round to the step it is already on and do nothing.
 */
const ZOOM_EPSILON = 1e-6;

/**
 * Aligned to the trigger rather than to the strip — unlike {@link POPUP_POSITIONER},
 * whose `alignOffset` exists to pull the project menu back over the strip's own
 * padding. This trigger sits in the middle of the strip, where the edge worth
 * lining up with is its own.
 */
const ZOOM_POSITIONER = { align: "start", sideOffset: 14 } as const;

/**
 * How far in or out the camera is, and the three ways to move it.
 *
 * It lands on this strip rather than in a corner of its own, for the reason the
 * strip exists at all: the canvas *is* the screen, so every panel parked on it
 * permanently is covering the work. There is already one thing always in view,
 * and a reading four characters wide can join it for free — where a fourth
 * floating panel would be a fourth thing to look past.
 *
 * The reading comes from a single value out of React Flow's store rather than
 * from `useViewport`, and this is its own component rather than a number read
 * up in the route. Both of those are about what re-renders during a gesture:
 * `useViewport` changes on a pan too, and reading either one in the route would
 * re-render the whole node graph on every frame of every zoom. Here the only
 * thing that re-renders is this strip, and only when the zoom can have changed.
 *
 * The bounds are read from the store as well, rather than restated here, so
 * that setting `minZoom`/`maxZoom` on the canvas one day moves the ends of this
 * control with it instead of leaving two answers to the same question.
 */
export function ZoomLevel() {
  const { zoomTo, fitView } = useReactFlow();

  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const nodeCount = useStore((state) => state.nodes.length);

  /**
   * Snapped to the five-percent grid rather than added to wherever we are.
   * "Fit to screen" lands on whatever fraction the board happens to need — 67%,
   * 83% — and stepping from there would carry that remainder through every
   * reading afterwards. Snapping means the first press tidies up and every one
   * after it moves a clean five.
   */
  function step(direction: 1 | -1) {
    const steps = zoom / ZOOM_STEP;
    const next =
      direction > 0 ? Math.floor(steps + ZOOM_EPSILON) + 1 : Math.ceil(steps - ZOOM_EPSILON) - 1;

    // No `duration`: a step is meant to be repeated, and an animation means
    // every press after the first is measured from a zoom that is still moving.
    void zoomTo(Math.min(maxZoom, Math.max(minZoom, next * ZOOM_STEP)));
  }

  return (
    // `modal={false}` for the reason the project menu gives: a backdrop across
    // the canvas would put the board out of reach for as long as this is open —
    // and this is a menu built to be left open.
    <Menu.Root modal={false}>
      <Menu.Trigger render={<Button variant="ghost" size="md" className={TRIGGER_CLASS} />}>
        {/* Fixed width and tabular figures because the strip is anchored on the
            left: without both, zooming past a digit boundary would slide the
            trigger's own chevron — the thing being pressed repeatedly — sideways
            out from under the pointer. */}
        <span className="min-w-9 text-center tabular-nums">
          {/* The word the number needs to mean anything, for the reader who has
              no strip to see it in the context of. */}
          <span className="sr-only">Zoom </span>
          {Math.round(zoom * 100)}%
        </span>
        <Icon name="expand_more" className="text-base text-neutral-400" />
      </Menu.Trigger>
      <Menu.Content positioner={ZOOM_POSITIONER}>
        {/*
         * `closeOnClick={false}` on all three. Stepping is done several times in
         * a row, and a menu that shut after the first press would turn "a bit
         * smaller" into four trips. Fitting keeps it too, though nobody fits
         * twice: what follows a fit is usually a step or two to taste, and
         * closing would take that away to save a press nobody asked to skip.
         * Escape and a press on the canvas still dismiss it, and the reading in
         * the trigger stays live above the popup while all this happens.
         */}
        {/* Magnifiers rather than a bare plus and minus. In a column of icons
            that all name what their row does, `add` and `remove` name something
            else entirely — every other menu in this app uses them for adding
            and removing things, not for moving a camera. */}
        <Menu.Item
          closeOnClick={false}
          disabled={zoom <= minZoom + ZOOM_EPSILON}
          onClick={() => step(-1)}
        >
          <Icon name="zoom_out" className="text-sm" />
          Zoom out
        </Menu.Item>
        <Menu.Item
          closeOnClick={false}
          disabled={zoom >= maxZoom - ZOOM_EPSILON}
          onClick={() => step(1)}
        >
          <Icon name="zoom_in" className="text-sm" />
          Zoom in
        </Menu.Item>

        <Menu.Separator />

        {/* Inert rather than hidden on an empty board, the way the node menu
            keeps an action it cannot currently perform: a menu whose contents
            change shape is a menu nobody learns the position of. The animation
            is worth it here and not on the steps — this is one move, and a
            camera that jumps across the board loses the reader. */}
        <Menu.Item
          closeOnClick={false}
          disabled={nodeCount === 0}
          onClick={() => void fitView({ duration: 200 })}
        >
          <Icon name="fit_screen" className="text-sm" />
          Fit to screen
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * Decorative rather than `role="separator"`: the strip is deliberately not a
 * `role="toolbar"` — that role promises arrow-key traversal between the
 * controls, and these are plain tab stops — so there are no groups here for a
 * separator to be announced between.
 */
function ToolbarSeparator() {
  return <span aria-hidden={true} className="mx-0.5 h-4 w-px bg-[rgba(218,220,224,0.1)]" />;
}

/**
 * The popup is aligned to the strip rather than to the button that opened it —
 * `alignOffset` pulls it back by the strip's own padding — and cleared far
 * enough below to read as a separate surface.
 */
const POPUP_POSITIONER = { align: "start", sideOffset: 14, alignOffset: -6 } as const;

/** Lit while its menu is open, matching what the menu rows themselves do. */
const TRIGGER_CLASS = "data-popup-open:bg-[rgba(218,220,224,0.08)]";

type ProjectAction = "rename" | "delete";

/**
 * The project's name, and what can be done to the project behind it.
 *
 * The dialogs are siblings of the menu rather than children of it, for the
 * reason the projects grid gives: a menu takes its whole popup out of the DOM
 * the moment a row is clicked, so a dialog nested inside would be unmounted by
 * the very click meant to open it.
 */
function ProjectMenu({
  projectId,
  name,
  readOnly
}: {
  projectId: string;
  name: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate();

  const [action, setAction] = useState<ProjectAction | null>(null);
  const [draftName, setDraftName] = useState(name);

  const rename = useRenameProject();
  const remove = useDeleteProject();

  function open(next: ProjectAction) {
    // The hooks outlive the dialogs — this component stays mounted while they
    // come and go — so a failed attempt would otherwise still be on screen the
    // next time one is opened. The draft is re-seeded for the same reason: it
    // starts from the name as it is now, not from an edit that was abandoned.
    rename.reset();
    remove.reset();
    setDraftName(name);
    setAction(next);
  }

  function close() {
    setAction(null);
  }

  return (
    <>
      {/*
       * `modal={false}` because the menu is floating over a canvas: the modal
       * flavour lays a backdrop across everything behind it, which would take
       * the whole board out of reach for as long as a menu is open.
       */}
      <Menu.Root modal={false}>
        <Menu.Trigger
          render={<Button variant="ghost" size="md" className={`max-w-56 ${TRIGGER_CLASS}`} />}
        >
          {/* `min-w-0` is what lets the truncation happen at all: a flex child
              refuses to shrink below its content without it, so a long name
              would push the chevron out of the button instead of clipping. */}
          <span className="min-w-0 truncate">{name}</span>
          <Icon name="expand_more" className="text-base text-neutral-400" />
        </Menu.Trigger>
        <Menu.Content positioner={POPUP_POSITIONER}>
          {/* A real link, not a row that calls `navigate`: leaving for the list
              is a navigation, so it should be middle-clickable, copyable, and
              visible in the status bar like any other. */}
          <Menu.LinkItem render={<Link to="/projects" />}>
            <Icon name="arrow_back" className="text-sm" />
            Back to projects
          </Menu.LinkItem>
          {/* Nothing below the separator on an archived project, so the menu is
              one row: the way back. Restoring is deliberately not offered here
              either — it is an edit, and the archive list is where a project is
              taken out of the archive. */}
          {readOnly ? null : (
            <>
              <Menu.Separator />
              <Menu.Item onClick={() => open("rename")}>
                <Icon name="edit" className="text-sm" />
                Rename
              </Menu.Item>
              {/* Only the label is red. The row's highlight stays neutral
                  because overriding the menu's preset would be a specificity
                  tie broken by whichever rule Tailwind happens to emit last. */}
              <Menu.Item className="text-red-400" onClick={() => open("delete")}>
                <Icon name="delete" className="text-sm" />
                Delete
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Root>

      <RenameDialog
        open={action === "rename"}
        onClose={close}
        value={draftName}
        onValueChange={setDraftName}
        onSubmit={(next) =>
          rename.mutate(
            { id: projectId, name: next },
            {
              onSuccess: () => {
                close();
                // The mutation invalidates the query this toolbar reads, so the
                // strip catches up on its own. The document title does not: it
                // comes from the layout route's loader, which only runs again
                // when the router is told to. Without this the tab would keep
                // announcing the old name for the rest of the session.
                void router.invalidate();
              }
            }
          )
        }
        error={rename.error}
        pending={rename.isPending}
      />

      <ConfirmDialog
        open={action === "delete"}
        onClose={close}
        title="Delete project?"
        description={`“${name}” and everything in it will be deleted. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        error={remove.error}
        pending={remove.isPending}
        // Unlike the grid's copy of this, the page cannot stay where it is: the
        // project it was showing is gone, and the route that reads it would
        // resolve to a 404 the next time anything asked.
        onConfirm={() =>
          remove.mutate({ id: projectId }, { onSuccess: () => void navigate({ to: "/projects" }) })
        }
      />
    </>
  );
}
