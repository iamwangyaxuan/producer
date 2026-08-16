import { Toast } from "@base-ui/react/toast";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ConfirmDialog, RenameDialog } from "#/components/block/project-dialogs";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";
import { initial } from "#/lib/initials";
import {
  useArchiveProject,
  useDeleteProject,
  useRenameProject,
  useRestoreProject
} from "#/lib/projects";

export interface ProjectCardProps {
  id: string;
  name: string;
  /** Nullable in the database; the paragraph is dropped rather than left blank. */
  description: string | null;
  /** Nullable in the database *and* able to 404 — both land on the generated cover. */
  image: string | null;
  /**
   * Whether this card is in the archive.
   *
   * It changes one thing and nothing else: the menu offers restore instead of
   * archive. The name links to the studio either way, because an archived
   * project opens there read-only. No dimming or badge: every card in that list
   * is archived, so a mark that appears on all of them distinguishes nothing.
   */
  archived?: boolean;
}

/**
 * A grid of image-less projects still has to be scannable, and identical grey
 * placeholders make that impossible. The hue is derived from the id, so a
 * project keeps the same colour across renders, across re-orderings, and between
 * the server and the client. Only the hue moves.
 */
function coverHue(id: string) {
  let hue = 0;

  for (let index = 0; index < id.length; index++) {
    hue = (hue * 31 + id.charCodeAt(index)) % 360;
  }

  return hue;
}

/**
 * Deliberately translucent and laid over the neutral cover rather than replacing
 * it, so the tint reads as a wash on the dark card instead of a flat block.
 * `hsla()` rather than `oklch()` because the value is inline and has no
 * fallback — this one is understood everywhere.
 */
function coverTint(id: string) {
  return `hsla(${coverHue(id)}, 70%, 55%, 0.22)`;
}

/**
 * Unmounts itself when the image cannot load. That is not what `alt=""` does:
 * Chrome still paints its broken-image glyph over the generated cover, which is
 * exactly the hole the fallback exists to avoid.
 *
 * The `<img>` is rendered during SSR so the browser starts fetching while it
 * parses the document — which also means the failure can land *before* React
 * hydrates, and React does not replay an `error` event it never witnessed. So
 * the settled-on-arrival case is checked once on mount, and `onError` covers
 * everything that fails afterwards.
 *
 * `alt=""` because the heading below already names the project — a second
 * announcement would only be noise.
 */
function CoverImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const element = ref.current;

    if (element?.complete && element.naturalWidth === 0) setFailed(true);
  }, []);

  if (failed) return null;

  return (
    <img
      ref={ref}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      // Layered over the generated cover instead of replacing it, so a dead URL
      // falls back to the tint rather than leaving a hole.
      className="absolute inset-0 size-full object-cover"
    />
  );
}

export default function ProjectCard({
  id,
  name,
  description,
  image,
  archived = false
}: ProjectCardProps) {
  // `name` is NOT NULL but nothing stops it being whitespace, and an empty
  // heading would leave the card with no accessible name at all.
  const title = name.trim() || "Untitled project";

  return (
    /*
     * Borderless and unfilled at rest: the card is its cover and its text, and
     * the page shows through everything else. The fill belongs to hover, and
     * with no border it is the only thing that ever marks the card's edge.
     *
     * That fill has to survive the pointer leaving the card for the menu it
     * opened — the popup is portalled to `<body>`, so the pointer really is
     * outside by then. `has-data-popup-open` reads the attribute Base UI puts
     * on the trigger, which keeps the lit state where it is caused rather than
     * mirroring it into React state that only styling would ever read.
     *
     * `relative` anchors the link's stretched pseudo-element; `group` is what
     * fades the menu button in with the fill rather than on its own hover. The
     * focus ring is drawn here but keyed to the link inside, so tabbing to the
     * project outlines the whole card while tabbing on to its menu button does
     * not — that one draws its own. Its colour is stated unconditionally for the
     * reason the button gives: `transition-colors` covers `outline-color`, so a
     * colour that only arrives with focus animates up from `currentColor` in
     * full view.
     */
    <div className="group relative flex h-full flex-col rounded-xl outline-blue-500 transition-colors hover:bg-neutral-800/60 has-data-popup-open:bg-neutral-800/60 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2">
      {/* Rounded on all four corners and clipping its own image, so the cover
          reads as a tile sitting on the card rather than as the card's top
          edge. A fixed ratio, so nothing reflows while covers stream in. */}
      <div className="relative grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-xl bg-neutral-800">
        <span
          aria-hidden={true}
          className="absolute inset-0"
          style={{ backgroundColor: coverTint(id) }}
        />
        <span
          aria-hidden={true}
          className="relative text-3xl font-semibold tracking-tight text-neutral-400 select-none"
        >
          {initial(title)}
        </span>
        {/* Keyed by url so a project that swaps its image gets a fresh attempt
            rather than inheriting the previous one's failure. */}
        {image ? <CoverImage key={image} src={image} /> : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-4">
        <div className="flex items-start gap-1">
          {/* `min-w-0` so a long name truncates instead of pushing the menu out. */}
          <h2 className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
            {/*
             * The whole card is one link target, but by a stretched
             * pseudo-element rather than by wrapping everything: the card now
             * holds a button, and a button inside an `<a>` is neither legal
             * markup nor clickable in the way anyone wants. The link keeps the
             * project's name as its text, so its accessible name is the name.
             * Its own outline is dropped because the card draws that ring
             * around itself instead of around three words of text.
             *
             * An archived card links too, and to the same place: the studio
             * opens an archived project read-only rather than answering "no
             * such project", so there is somewhere to go and the card should
             * take you there. Looking at what was made is the whole reason to
             * keep an archive.
             */}
            <Link
              to="/studio/$projectId"
              params={{ projectId: id }}
              className="outline-hidden after:absolute after:inset-0"
            >
              {title}
            </Link>
          </h2>
          <ProjectActions id={id} name={title} archived={archived} />
        </div>
        {description ? (
          <p className="line-clamp-2 text-sm text-neutral-400">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

type ProjectAction = "rename" | "archive" | "delete";

/**
 * The menu and the three dialogs it opens. All four are here rather than one
 * component each because they share the state that decides which is showing:
 * exactly one action can be in flight, and a menu row selects it.
 *
 * The dialogs are siblings of the menu rather than children of it. A menu
 * closes the moment a row is clicked and takes its whole popup out of the DOM
 * with it, so a dialog nested inside would be unmounted by the click that was
 * supposed to open it.
 */
function ProjectActions({ id, name, archived }: { id: string; name: string; archived: boolean }) {
  const [action, setAction] = useState<ProjectAction | null>(null);
  const [draftName, setDraftName] = useState(name);

  const rename = useRenameProject();
  const archive = useArchiveProject();
  const restore = useRestoreProject();
  const remove = useDeleteProject();
  const toast = Toast.useToastManager();

  /**
   * The one action with no dialog in front of it, because there is nothing to
   * confirm: restoring loses nothing and archiving it again is one click away.
   * That leaves nowhere on screen to report a failure — the menu closes on
   * click and the card it belonged to moves out of this list on success — so
   * this is the one that goes to the toast the canvas already uses.
   */
  function restoreNow() {
    restore.mutate(
      { id },
      {
        onError: (error) =>
          toast.add({
            type: "error",
            title: "Could not restore the project",
            // A failed server function can carry driver-level detail, so only
            // the development build shows the original message.
            description: import.meta.env.DEV ? error.message : "Please try again."
          })
      }
    );
  }

  function open(next: ProjectAction) {
    // The hooks outlive the dialogs — this component stays mounted while they
    // come and go — so a failed attempt would otherwise still be on screen the
    // next time one is opened. The draft is re-seeded for the same reason: it
    // starts from the name as it is now, not from an edit that was abandoned.
    rename.reset();
    archive.reset();
    remove.reset();
    setDraftName(name);
    setAction(next);
  }

  function close() {
    setAction(null);
  }

  return (
    <>
      <Menu.Root>
        {/*
         * Invisible until the card is hovered, but never removed: `opacity-0`
         * keeps it in the tab order and in the accessibility tree, so the
         * actions are reachable by keyboard on a card nobody is pointing at.
         * Focus and an open menu both bring it back, and so does a coarse
         * pointer — a touch screen has no hover to reveal it with, and a
         * control that can only be found by hovering is a control a phone does
         * not have.
         *
         * The transition is restated because it merges over the button's own
         * `transition-colors`, and the opacity has to ease alongside the fill it
         * appears with. `filter` stays out of it: the press blur every button on
         * this surface does should land at once rather than fade in.
         */}
        <Menu.Trigger
          aria-label={`Actions for ${name}`}
          render={
            <Button
              variant="ghost"
              size="sm"
              icon
              className="relative z-10 -me-1 -mt-0.5 opacity-0 transition-[color,background-color,opacity] group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:bg-[rgba(218,220,224,0.08)] data-popup-open:opacity-100 pointer-coarse:opacity-100"
            />
          }
        >
          <Icon name="more_vert" className="text-base" />
        </Menu.Trigger>
        <Menu.Content positioner={{ align: "end", sideOffset: 4 }}>
          <Menu.Item onClick={() => open("rename")}>
            <Icon name="edit" className="text-sm" />
            Rename
          </Menu.Item>
          {archived ? (
            <Menu.Item onClick={restoreNow}>
              <Icon name="unarchive" className="text-sm" />
              Restore
            </Menu.Item>
          ) : (
            <Menu.Item onClick={() => open("archive")}>
              <Icon name="archive" className="text-sm" />
              Archive
            </Menu.Item>
          )}
          <Menu.Separator />
          {/* Only the label is red. The row's highlight stays neutral because
              overriding the menu's preset would be a specificity tie broken by
              whichever rule Tailwind happens to emit last. */}
          <Menu.Item className="text-red-400" onClick={() => open("delete")}>
            <Icon name="delete" className="text-sm" />
            Delete
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>

      <RenameDialog
        open={action === "rename"}
        onClose={close}
        value={draftName}
        onValueChange={setDraftName}
        onSubmit={(next) => rename.mutate({ id, name: next }, { onSuccess: close })}
        error={rename.error}
        pending={rename.isPending}
      />

      <ConfirmDialog
        open={action === "archive"}
        onClose={close}
        title="Archive project?"
        description={`“${name}” will move to the archive. You can restore it from there whenever you like.`}
        confirmLabel="Archive"
        error={archive.error}
        pending={archive.isPending}
        onConfirm={() => archive.mutate({ id }, { onSuccess: close })}
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
        onConfirm={() => remove.mutate({ id }, { onSuccess: close })}
      />
    </>
  );
}

/**
 * Shown by the route's pending state. It repeats the card's geometry — the
 * cover's ratio and radius, the body's padding — because the one thing a
 * skeleton has to get right is not moving anything when the real card replaces
 * it.
 */
export function ProjectCardSkeleton() {
  return (
    <div aria-hidden={true} className="flex h-full animate-pulse flex-col rounded-xl">
      <div className="aspect-[16/10] w-full rounded-xl bg-neutral-800" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
        <div className="h-4 w-2/5 rounded bg-neutral-800" />
        <div className="h-3 w-full rounded bg-neutral-800/60" />
        <div className="h-3 w-3/5 rounded bg-neutral-800/60" />
      </div>
    </div>
  );
}
