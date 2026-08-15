import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { Children } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cn, tv } from "tailwind-variants";

import { initial } from "#/lib/initials";

/**
 * A face, or the letter standing in for one.
 *
 * Unlike the menus and dialogs in this folder, this does not hand back the
 * parts it wraps. Every avatar in this app is the same sentence — a picture if
 * there is one, a letter if there is not — so a compound API would be three
 * lines of ceremony at each call site to say a thing none of them says
 * differently. Base UI is still doing the work underneath: it owns the image's
 * loading status, which is what makes the fallback appear when a URL *fails*
 * rather than only when it is absent. That case used to render a broken image
 * at every call site here, because each of them had reimplemented the easy half
 * of this and skipped the hard one.
 */
const avatarClass = tv({
  base: [
    "relative flex shrink-0 items-center justify-center overflow-hidden",
    "leading-none font-semibold select-none",
    /**
     * The ring is the gap between overlapping discs in a group, so its colour
     * is the surface the group sits on rather than anything about the person.
     * It comes through a variable the group sets, which is what lets a lone
     * avatar carry the same class list and simply draw nothing: `ring-2` is a
     * box-shadow, so a transparent one costs no layout either way.
     */
    "ring-2 ring-[var(--avatar-ring,transparent)]"
  ],
  variants: {
    size: {
      sm: "size-6 text-[10px]",
      md: "size-7 text-[11px]"
    },
    /**
     * A circle is a person. The square is for the things that are shaped like
     * an avatar without being a face — an organization, mostly — where a circle
     * would quietly claim there is someone behind it.
     */
    shape: {
      circle: "rounded-full",
      square: "rounded-lg"
    },
    /** Whether the disc's colour is the caller's or the neutral default. */
    tinted: {
      false: "bg-[rgba(218,220,224,0.16)] text-neutral-200",
      true: "text-white"
    }
  },
  defaultVariants: { size: "md", shape: "circle", tinted: false }
});

export interface AvatarProps {
  /** Names the person, and supplies the letter when there is no picture. */
  name: string;
  src?: string | null;
  /**
   * A fill of the caller's choosing — presence colours, where the disc is also
   * how someone's cursor is identified on the canvas.
   */
  color?: string;
  size?: "sm" | "md";
  shape?: "circle" | "square";
  /**
   * Hides the whole thing from assistive technology, for the places where the
   * name is already being read out right next to it and the avatar is decoration
   * repeating it.
   */
  decorative?: boolean;
  className?: string;
}

export default function Avatar({
  name,
  src,
  color,
  size,
  shape,
  decorative = false,
  className
}: AvatarProps) {
  return (
    <BaseAvatar.Root
      // The name is worth a tooltip on every one of these: in a group the
      // faces are all that is shown, and a picture of someone is not their
      // name to anyone who has not met them.
      title={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn(avatarClass({ size, shape, tinted: color !== undefined }), className)}
      style={color ? ({ backgroundColor: color } as CSSProperties) : undefined}
    >
      {src ? (
        <BaseAvatar.Image
          src={src}
          alt={name}
          // Google's avatar URLs refuse a request that names another site as
          // the referrer, and a broken face is worse than none.
          referrerPolicy="no-referrer"
          // Browsers hand out image dragging for free; on a face in the corner
          // it answers a press with a ghost of a colleague trailing the cursor,
          // offering to drop them into another window.
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
      <BaseAvatar.Fallback>{initial(name)}</BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}

/**
 * Several of them, overlapped, with the ones past `max` collapsed into a count.
 *
 * Overlapped rather than gapped: a run of separate circles is a list, and this
 * is meant to read as a group. What makes the overlap legible is the ring each
 * disc wears in the colour of whatever the group is sitting on — set once here
 * as `--avatar-ring` rather than passed to every child, so adding an avatar to
 * a group cannot forget it.
 *
 * The overflow chip counts *including* the slot it occupies: at `max` of five
 * and six people, it shows four faces and `+2`, never five faces and `+1` —
 * the chip is standing in for the sixth person as well as itself.
 */
export interface AvatarGroupProps {
  /** How many slots the strip has, the overflow chip included. */
  max?: number;
  /** Named for the tooltip on the chip — the people the count stands for. */
  overflowTitle?: string;
  className?: string;
  children: ReactNode;
}

/** The surface these sit on by default: the toolbar and presence strip's glass. */
const GROUP_RING = "[--avatar-ring:#161718]";

export function AvatarGroup({ max = 5, overflowTitle, className, children }: AvatarGroupProps) {
  const items = Children.toArray(children);
  const visible = items.length <= max ? items : items.slice(0, max - 1);
  const overflow = items.length - visible.length;

  return (
    <div className={cn("flex -space-x-2", GROUP_RING, className)}>
      {visible}
      {overflow > 0 ? (
        <span
          title={overflowTitle}
          className={cn(
            avatarClass({ shape: "circle" }),
            // Capped at two digits: the strip is a glance at who is here, and
            // past ninety-nine the exact number has stopped being the point.
            "ring-[var(--avatar-ring)]"
          )}
        >
          +{Math.min(overflow, 99)}
        </span>
      ) : null}
    </div>
  );
}
