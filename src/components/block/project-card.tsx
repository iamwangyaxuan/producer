import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export interface ProjectCardProps {
  id: string;
  name: string;
  /** Nullable in the database; the paragraph is dropped rather than left blank. */
  description: string | null;
  /** Nullable in the database *and* able to 404 — both land on the generated cover. */
  image: string | null;
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

/** Spread instead of `charAt` so an emoji or a CJK name keeps its first whole glyph. */
function coverInitial(name: string) {
  return [...name][0]?.toUpperCase() ?? "?";
}

/**
 * Everything that decides the card's size and shape, and nothing that decides
 * how it behaves. {@link ProjectCardSkeleton} renders the same shell, which is
 * what stops the placeholder and the real card from drifting apart — the one
 * thing a skeleton has to get right.
 */
const CARD_SHELL_CLASS =
  "flex h-full flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900";

/**
 * The whole card is the link target. That is legal markup because the card holds
 * no interactive content of its own, and it means the focus ring outlines the
 * thing a keyboard user is actually about to activate.
 */
const CARD_CLASS = [
  CARD_SHELL_CLASS,
  "transition hover:border-neutral-700 hover:bg-neutral-800/60",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-50"
].join(" ");

/** A fixed ratio, so nothing reflows while covers stream in. */
const COVER_CLASS =
  "relative grid aspect-[16/10] w-full place-items-center overflow-hidden bg-neutral-800";

const COVER_INITIAL_CLASS =
  "relative text-3xl font-semibold tracking-tight text-neutral-400 select-none";

/**
 * Layered over the generated cover instead of replacing it, so a dead URL falls
 * back to the tint rather than leaving a hole. `alt=""` because the heading
 * below already names the project — a second announcement would only be noise.
 */
const COVER_IMAGE_CLASS = "absolute inset-0 size-full object-cover";

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
      className={COVER_IMAGE_CLASS}
    />
  );
}

const BODY_CLASS = "flex min-w-0 flex-1 flex-col gap-1 p-4";

const NAME_CLASS = "truncate text-sm font-medium text-foreground";

const DESCRIPTION_CLASS = "line-clamp-2 text-sm text-neutral-400";

export default function ProjectCard({ id, name, description, image }: ProjectCardProps) {
  // `name` is NOT NULL but nothing stops it being whitespace, and an empty
  // heading would leave the card with no accessible name at all.
  const title = name.trim() || "Untitled project";

  return (
    <Link to="/studio/$projectId" params={{ projectId: id }} className={CARD_CLASS}>
      <div className={COVER_CLASS}>
        <span
          aria-hidden={true}
          className="absolute inset-0"
          style={{ backgroundColor: coverTint(id) }}
        />
        <span aria-hidden={true} className={COVER_INITIAL_CLASS}>
          {coverInitial(title)}
        </span>
        {/* Keyed by url so a project that swaps its image gets a fresh attempt
            rather than inheriting the previous one's failure. */}
        {image ? <CoverImage key={image} src={image} /> : null}
      </div>

      <div className={BODY_CLASS}>
        <h2 className={NAME_CLASS}>{title}</h2>
        {description ? <p className={DESCRIPTION_CLASS}>{description}</p> : null}
      </div>
    </Link>
  );
}

/** Shown by the route's pending state; shares {@link CARD_SHELL_CLASS} with the real card. */
export function ProjectCardSkeleton() {
  return (
    <div aria-hidden={true} className={`${CARD_SHELL_CLASS} animate-pulse`}>
      <div className={COVER_CLASS} />
      <div className={`${BODY_CLASS} gap-2`}>
        <div className="h-4 w-2/5 rounded bg-neutral-800" />
        <div className="h-3 w-full rounded bg-neutral-800/60" />
        <div className="h-3 w-3/5 rounded bg-neutral-800/60" />
      </div>
    </div>
  );
}
