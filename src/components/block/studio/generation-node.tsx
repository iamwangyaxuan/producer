import { NodeResizeControl, useReactFlow, useStore } from "@xyflow/react";
import type { ControlPosition, Node, NodeProps, NodeTypes } from "@xyflow/react";
// The stylesheet is NOT imported here: `styles.css` pulls it in under
// `layer(base)`, which is what lets the `.canvas-video` overrides there win
// without specificity games. A second, unlayered import from this module
// would outrank them all and quietly restore the stock skin.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "tailwind-variants";
import type Player from "video.js/dist/types/player";

import { ConfirmDialog } from "#/components/block/project-dialogs";
import type { Modality } from "#/components/block/studio/ai-composer";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Progress from "#/components/ui/progress";
import Skeleton from "#/components/ui/skeleton";
import { aspectRatioValue } from "#/lib/aspect-ratio";
import { assetContentUrl, assetFileName } from "#/lib/asset-links";

export type GenerationStatus = "pending" | "ready" | "failed";

export interface GenerationNodeData extends Record<string, unknown> {
  modality: Modality;
  /** What was asked for — or, on an uploaded file, its name. */
  prompt: string;
  model: string;
  aspectRatio?: string;
  status: GenerationStatus;
  /**
   * The asset this node shows, and the only name for it the document keeps —
   * the URL is derived from it at render time rather than stored beside it.
   * Absent until the call that creates the asset row answers, which is a
   * moment the node spends pending.
   */
  assetId?: string;
  /** How the file came to exist. Absent means an AI generation. */
  source?: "ai" | "upload";
  /**
   * What the file is called — an upload's own name, or the phrase a model
   * wrote for a generation. Held here so the node can build a named URL
   * without a lookup; absent when a generation's naming call failed, where
   * the fallback chain in `assetTitle` covers it.
   */
  title?: string;
  /**
   * What the bytes are, e.g. "video/mp4". The serving URL carries no
   * extension, so a player that picks its pipeline by source type has to be
   * told. Written in the same patch that turns the node ready, so it is
   * absent only while there is nothing to play yet.
   */
  mimeType?: string;
  /**
   * The collaboration client the request started in. Informational — the
   * failure watchdog judges on age, not presence — but it says which tab to
   * blame when a generation dies with its creator.
   */
  generatedBy?: number;
  /**
   * When the generation was asked for. Generation runs in the creator's tab,
   * so a tab that closes mid-request leaves a node pending forever; any
   * client may declare it failed once this stamp is old enough that no
   * request could still be running.
   */
  requestedAt?: number;
}

export type GenerationNode = Node<GenerationNodeData, "generation">;

/**
 * Whether the canvas is currently in its move-things-around mode — the modifier
 * key is down, so panning and dragging are live.
 *
 * Context rather than node data: it changes on a keypress and belongs to the
 * canvas, not to any one result. Writing it into every node's data would rewrite
 * the whole graph twice per key press to say something none of them own.
 */
export const DragModeContext = createContext(false);

/**
 * What a node can be asked to do about its own failure.
 *
 * Context rather than node data for a harder reason than {@link DragModeContext}:
 * these are functions, and node data is a Yjs record that every other person in
 * the room receives and every future session reads back. Only the canvas knows
 * whether a retry is even possible — an upload can only be retried by the tab
 * still holding the file — so it answers both questions here, per node, and the
 * document stays a description of results rather than of this tab's abilities.
 */
export interface NodeActions {
  canRetry: (id: string, data: GenerationNodeData) => boolean;
  retry: (id: string, data: GenerationNodeData) => void;
}

export const NodeActionsContext = createContext<NodeActions | null>(null);

/**
 * The same retry, already bound to the node that is rendering — so the failure
 * notice deep inside a body can offer it without being handed an id and a data
 * record it has no other use for. `null` when this node has nothing to try
 * again with.
 */
const RetryContext = createContext<(() => void) | null>(null);

/**
 * Where this node's bytes come from, once there are any.
 *
 * Derived from the id rather than stored, which is why nothing needs fetching
 * or refreshing to render a node: the URL for an asset is a pure function of
 * its id and never changes.
 *
 * The status gate is what that pure function costs. A node is given its
 * `assetId` when the generation *starts*, so a URL exists for it long before
 * any byte does — and the serving route answers 404 until the row is ready.
 * A media element that meets that 404 marks itself broken permanently, because
 * the URL never changes and so never gives it a second attempt. Withholding
 * the address until the bytes exist is what keeps the first load the real one.
 */
function assetSrc(data: GenerationNodeData) {
  if (data.status !== "ready" || !data.assetId) return undefined;

  return assetContentUrl(data.assetId, { filename: nodeFileName(data) });
}

/** The name this node's file carries in its URL and on disk. */
function nodeFileName(data: GenerationNodeData) {
  return assetFileName({
    kind: data.modality,
    title: data.title ?? null,
    filename: null,
    prompt: data.prompt,
    mimeType: data.mimeType ?? null
  });
}

/**
 * How wide a node is when it has no picture to be the shape of.
 *
 * Sound is the only one, and it wants a width the way a paragraph does: the row
 * has to carry a transport, a clock, and the prompt that is the single thing
 * telling two players apart. Everything with a picture takes its size from its
 * own proportions instead — see {@link VISUAL_AREA}.
 *
 * Also the last-resort box in `canvas-placement`, for a node whose data has not
 * arrived but which still has to be something the next one avoids.
 */
export const NODE_WIDTH = 320;

/**
 * Every picture on the board covers the same area, whatever shape it is.
 *
 * The rule this replaces was one width for every node, which sounds even and is
 * not: with width pinned, height follows the ratio alone, so a 3:4 phone photo
 * stood 427 pixels tall beside a 16:9 still's 180 and a 9:16 clip took three
 * times the board a landscape one did. At the same zoom on the same canvas, a
 * page of holiday photos ran out of screen after a couple of files while a page
 * of stills held four times as many — a difference decided by nothing but which
 * way the camera was held.
 *
 * Equal area is what "the same size" means to the eye, and it is what makes how
 * much fits at 100% a property of the canvas rather than of the files that
 * happened to land on it. Written as the square it is equivalent to, because
 * that is the number worth turning: this is the one dial for how dense a board
 * is, and everything grows or shrinks in step with it.
 */
const VISUAL_AREA = 200 * 200;

/**
 * No side longer than this, whatever the area works out to.
 *
 * Equal area bounds a node only while its proportions are ordinary. A 10:1
 * panorama comes out 632 pixels wide — and a single file wide enough to push
 * everything else off the screen is the exact thing this whole rule exists to
 * stop. The cap takes the long side and lets the short one follow, so the shape
 * survives and only the area gives way. It does not bite until about 4.4:1,
 * which nothing reaches without being asked for it.
 */
const MAX_VISUAL_SIDE = 420;

/**
 * Out of the way until the pointer is on the node — and, the half that had been
 * missing, out of the way of the pointer too.
 *
 * A transparent control still takes the press. On the toolbar that was a bite
 * out of the top-right corner of every node nobody was pointing at; on a handle
 * it is far worse, because a handle does not shrink with the board — see
 * {@link HANDLE_SIZE} — so at a fifth zoom its box is a hundred and forty canvas
 * pixels, reaching seventy past the corner it belongs to and well into whatever
 * node sits next to it. Tying `pointer-events` to the same hover the opacity
 * already answers to means a control nobody can see is a control nothing has to
 * get past.
 *
 * A coarse pointer keeps its own — there is no hover there to earn it with, and
 * a canvas nothing can be resized on is worse than one where the handles are
 * only felt for.
 *
 * The resize handles no longer share this: theirs additionally waits for drag
 * mode, built where they are (see {@link ResizeHandles}), so this const is the
 * toolbar's alone.
 */
const REVEAL_ON_HOVER = [
  "pointer-events-none opacity-0 transition-opacity duration-150",
  "group-hover:pointer-events-auto group-hover:opacity-100",
  "pointer-coarse:pointer-events-auto"
].join(" ");

/**
 * The video transport's version of {@link REVEAL_ON_HOVER}, wanting the same
 * three things for the same three reasons: hidden until pointed at, not in the
 * way while hidden, and handed over outright to a pointer that cannot hover.
 *
 * The second of those is the one that is easy to skip here. The bottom strip
 * spans the full width of the node and it swallows the press that starts a node
 * drag — so a transparent one is a band along the bottom of every clip on the
 * board that the node cannot be picked up by.
 *
 * It parts from the toolbar on focus. The toolbar reveals on `focus-within`,
 * which is right for two buttons nothing but the keyboard reaches; here an
 * ordinary mouse press on play leaves that button focused in most browsers, and
 * `focus-within` would then pin the transport open for the rest of the session
 * on the first clip anyone started. `:focus-visible` is the same courtesy to the
 * keyboard without the mouse being able to claim it.
 *
 * Both places this is worn — the strip, and the wrapper around the centre button
 * — are containers of the focusable thing rather than the focusable thing
 * itself, which is what makes one `has-` rule serve both.
 */
const TRANSPORT_ON_HOVER = [
  "pointer-events-none opacity-0",
  "group-hover:pointer-events-auto group-hover:opacity-100",
  "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
  "pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
].join(" ");

/**
 * Sound has no shape of its own; a player is as tall as a player needs to be.
 *
 * Two rows tall rather than one, and the second row is not decoration. The
 * toolbar sits sixteen pixels down from the top edge and stands thirty-two tall,
 * so on a single-row player it landed squarely on the transport it was supposed
 * to sit beside. Making room for it is also what makes room for the prompt,
 * which is the only thing distinguishing one of these from the next.
 */
export const SOUND_HEIGHT = 88;

/**
 * How big a node will be before anything has measured it.
 *
 * React Flow fills in `measured` only after it has laid a node out, which has
 * not happened for one added in the tick it is being placed in — and a node
 * whose size reads as zero is a node everything else is happy to be placed on
 * top of. The dimensions are known here anyway: they follow from the ratio the
 * result was asked for, or that the uploaded file turned out to have.
 *
 * Only ever consulted when a node is *born*. A node's size lives on the node
 * from then on, because the resize handles write to it — so turning
 * {@link VISUAL_AREA} changes what lands next and leaves every board already
 * arranged exactly as its author left it.
 */
export function nodeSize(data: GenerationNodeData) {
  if (data.modality === "voice" || data.modality === "music") {
    return { width: NODE_WIDTH, height: SOUND_HEIGHT };
  }

  const ratio = aspectRatioValue(data.aspectRatio) ?? 1;

  // Both sides from the area, rather than one from the other: deriving the
  // height from an already-rounded width walks the area off by a percent or so
  // on the narrow shapes, and these coming out equal is the entire point.
  let width = Math.sqrt(VISUAL_AREA * ratio);
  let height = Math.sqrt(VISUAL_AREA / ratio);

  if (width > MAX_VISUAL_SIDE) {
    width = MAX_VISUAL_SIDE;
    height = MAX_VISUAL_SIDE / ratio;
  } else if (height > MAX_VISUAL_SIDE) {
    height = MAX_VISUAL_SIDE;
    width = MAX_VISUAL_SIDE * ratio;
  }

  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Committed to the DOM before the transition is asked for. A cached image can
 * fire `load` in the same frame it mounts, and flipping the class in that frame
 * means the browser only ever sees the end state — no transition, the content
 * simply appears. Two frames is the reliable way to say "after the first paint".
 *
 * The timeout is not a belt-and-braces duplicate: a hidden tab is not painting,
 * so those frames never arrive. Waiting on them alone leaves anything that
 * finishes generating in a background tab stuck as a skeleton — the reveal is
 * queued behind a frame that only comes back when the person does. Whichever
 * fires first wins; on a page nobody is looking at that is the timeout, and
 * skipping the animation there costs nothing.
 */
function afterFirstPaint(run: () => void) {
  let done = false;

  const once = () => {
    if (done) return;

    done = true;
    run();
  };

  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, 100);
}

/**
 * Slow on purpose: the point is to watch content resolve, and anything brisk
 * enough to feel like a swap loses that. The skeleton fades out on the very same
 * duration — if it left any sooner the canvas would show through the media while
 * the media was still half transparent.
 */
const REVEAL_DURATION = "duration-[1600ms] ease-out";

/**
 * Blurred and transparent until the media says it has enough to show, then eased
 * into place over the skeleton it replaces.
 *
 * `blur-[0px]` rather than `blur-none`, because `none` is not a length — the
 * filter would jump instead of interpolating, which is the whole effect.
 */
const revealClass = (revealed: boolean) =>
  cn(
    "transition-[filter,opacity]",
    REVEAL_DURATION,
    revealed ? "opacity-100 blur-[0px]" : "opacity-0 blur-lg"
  );

const skeletonClass = (revealed: boolean) =>
  cn("absolute inset-0 rounded-none transition-opacity", REVEAL_DURATION, revealed && "opacity-0");

/**
 * Whether the result has a shape of its own to keep. It decides which body the
 * node renders and, through the resize controls, whether dragging a corner is
 * allowed to change the node's proportions — which is also why the canvas needs
 * to be able to ask: a resize that snaps to a guide has to derive the other
 * dimension for these, and leave it alone for the rest.
 */
export function isVisual(data: GenerationNodeData) {
  return data.modality === "image" || data.modality === "video";
}

export default function GenerationNodeView({ id, data, selected }: NodeProps<GenerationNode>) {
  const visual = isVisual(data);
  const dragMode = useContext(DragModeContext);
  const actions = useContext(NodeActionsContext);

  // Asked only of a node that actually failed: `canRetry` reaches into what
  // this tab is holding, and there is nothing to ask about a node that is
  // still running or already finished.
  const retry =
    data.status === "failed" && actions?.canRetry(id, data) ? () => actions.retry(id, data) : null;

  return (
    // `group` so the corner handles can wait for the pointer, and `size-full`
    // because the node's dimensions now live on the node itself — that is what
    // the resize controls below write to, and what makes them mean anything.
    <div
      aria-busy={data.status === "pending"}
      aria-label={`${data.modality} generation: ${data.prompt}`}
      className={cn(
        "group relative size-full",
        // `cursor` inherits, so saying nothing here lets React Flow's own grab
        // cursor through while the modifier is held. At rest it would otherwise
        // hand out the pointer it uses for anything selectable, which reads as a
        // promise this canvas does not keep until the modifier is down.
        !dragMode && "cursor-default"
      )}
    >
      <div
        className={cn(
          // No frame at rest — the result is the node. Selection gets a ring
          // rather than a border so there is still something to see when one is
          // picked, without giving every node an edge it does not need. Drag
          // mode used to add a hover outline on top; the resize handles are the
          // ones saying "this can be taken hold of" now, so the result itself
          // stays unframed in every state but selection.
          "size-full overflow-hidden rounded-xl",
          selected && "ring-1 ring-[rgba(218,220,224,0.35)]"
        )}
      >
        <RetryContext value={retry}>
          {data.modality === "video" ? (
            <VideoBody data={data} />
          ) : visual ? (
            <VisualBody data={data} />
          ) : (
            <SoundBody data={data} />
          )}
        </RetryContext>
      </div>

      <TypeBadge modality={data.modality} />

      <NodeToolbar id={id} data={data} />

      <ResizeHandles visual={visual} />
    </div>
  );
}

/**
 * The same glyphs the composer's tabs use, so the vocabulary someone chose a
 * modality in is the vocabulary the result wears.
 */
const MODALITY_ICONS: Record<Modality, string> = {
  image: "image",
  voice: "graphic_eq",
  music: "music_note",
  video: "movie"
};

/**
 * What kind of file this is, said once, in the corner the eye starts at. The
 * toolbar's material — translucent white, black ink — worn as a label rather
 * than a control: it takes no pointer, and it says nothing to a screen
 * reader because the node's own label already opens with the modality. It is
 * there from the first skeleton, which is when knowing what is coming is
 * worth the most.
 */
function TypeBadge({ modality }: { modality: Modality }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-2 left-2 rounded-lg bg-[rgba(255,255,255,0.6)] p-1 text-black shadow-[0_2px_10px_rgba(0,0,0,0.12)] backdrop-blur-xs"
    >
      <Icon name={MODALITY_ICONS[modality]} className="block text-sm" />
    </div>
  );
}

function VisualBody({ data }: { data: GenerationNodeData }) {
  const [revealed, setRevealed] = useState(false);
  const [broken, setBroken] = useState(false);

  const src = assetSrc(data);
  const failed = data.status === "failed" || broken;

  return (
    // Fills whatever the node has been sized to. The ratio still decides that
    // size at creation — see `nodeSize` — so the skeleton is the shape of the
    // picture before the picture exists, and nothing reflows when it lands.
    <div className="relative size-full">
      <Skeleton className={skeletonClass(revealed)} />

      {failed ? <Failure /> : null}

      {src && !failed ? (
        <img
          src={src}
          alt={data.prompt}
          // Browsers let an image be dragged out of the page on its own, which
          // puts a ghost under the cursor and takes the pointer away from the
          // node drag that was actually starting.
          draggable={false}
          onLoad={() => afterFirstPaint(() => setRevealed(true))}
          onError={() => setBroken(true)}
          className={cn("absolute inset-0 size-full object-cover", revealClass(revealed))}
        />
      ) : null}
    </div>
  );
}

/**
 * A clip at rest, with a transport of its own — one that stays off the picture
 * until the pointer is on the node; see {@link TRANSPORT_ON_HOVER}.
 *
 * Nothing plays until asked: a board where every clip is running is a board
 * where nothing can be looked at, and because playback now begins with a press,
 * sound arrives with it — the `muted` that autoplay demanded is gone, and with
 * it the mute toggle, which without an autoplay to work around was never a
 * control so much as an apology for one.
 *
 * The transport parts company with the audio player's here, and the picture is
 * the whole reason. A clip has a frame to press, so the play control goes where
 * every player anyone has used puts it — the middle, over the picture, with the
 * entire frame answering to it — and the strip along the bottom is left saying
 * only where in the clip we are. The audio player keeps its play button in the
 * row because a row is all it has.
 *
 * video.js runs the playback — source pipelines, buffering, the parts worth
 * not rebuilding — but draws nothing: `controls: false` strips its chrome, and
 * the transport is this component's own, so the player reads as part of the
 * canvas instead of a library skin fighting it. Double-click is stripped too
 * (`userActions`): video.js would answer it with fullscreen, which on a board
 * tile is a trapdoor.
 *
 * The library is imported on demand inside the effect because it expects a
 * document to exist, and this module is also loaded while the route renders
 * on the server.
 */
function VideoBody({ data }: { data: GenerationNodeData }) {
  const host = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const dragMode = useContext(DragModeContext);

  const [revealed, setRevealed] = useState(false);
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);

  const failed = data.status === "failed" || broken;
  const src = assetSrc(data);
  const mimeType = data.mimeType;

  useEffect(() => {
    if (!src) return;

    // A new source is a new attempt: without this a node that failed once
    // stays failed after its src is patched, because `broken` has no other
    // way back.
    setBroken(false);
    setRevealed(false);
    setPlaying(false);
    setElapsed(0);
    setTotal(0);

    let player: Player | null = null;
    let cancelled = false;

    void import("video.js")
      .then(({ default: videojs }) => {
        const container = host.current;

        if (cancelled || !container) return;

        // video.js replaces the element it is handed, so it gets one of its
        // own creation rather than anything React is reconciling.
        const element = document.createElement("video-js");
        element.classList.add("canvas-video");
        container.appendChild(element);

        player = videojs(element, {
          // The engine only — the transport below is rendered by React.
          controls: false,
          autoplay: false,
          preload: "auto",
          fill: true,
          playsinline: true,
          // Double-click would go fullscreen; nothing on a canvas tile should.
          userActions: { doubleClick: false },
          // The serving URL has no extension, so the type is stated outright —
          // it lands in the same patch as the `ready` that produced this src.
          sources: [{ src, type: mimeType }]
        });

        // The reveal waits for a decodable first frame, not just metadata: a
        // clip that is not playing is a still, and the still must exist before
        // the skeleton hands over to it.
        player.one("loadeddata", () => afterFirstPaint(() => setRevealed(true)));
        player.on("durationchange", () => setTotal(player?.duration() ?? 0));
        player.on("timeupdate", () => setElapsed(player?.currentTime() ?? 0));
        player.on("play", () => setPlaying(true));
        player.on("pause", () => setPlaying(false));
        player.on("ended", () => setPlaying(false));
        player.on("error", () => setBroken(true));

        playerRef.current = player;
      })
      .catch(() => {
        // The chunk did not load — offline, or a deploy that moved it. Without
        // this the node would sit on its skeleton forever, waiting for a player
        // that is never coming; the failure state at least says so and the
        // toolbar's download still works.
        if (!cancelled) setBroken(true);
      });

    return () => {
      cancelled = true;
      playerRef.current = null;
      player?.dispose();
      player = null;
    };
  }, [src, mimeType]);

  /**
   * `timeupdate` is the wrong clock to draw a bar with. It fires about four
   * times a second, so the indicator does not travel — it ticks, in steps that
   * are eight pixels wide on a ten-second clip and only get wider the shorter
   * the clip is.
   *
   * The cheap fix is a CSS transition on the width, and it is wrong in the way
   * that matters: a transition smooths the steps by predicting the next one,
   * and the prediction fails exactly when the truth is worth having — a stall,
   * a seek, a rate change — leaving the bar gliding confidently to a place the
   * clip is not. Asking the player where it is, once per frame, cannot be wrong
   * about where the clip is, because it is asking rather than guessing.
   *
   * Only while playing. A paused clip has nothing to interpolate, `timeupdate`
   * still covers the one move it can make, and a frame loop per node on a board
   * of clips is a cost worth paying only for the ones actually running.
   */
  useEffect(() => {
    if (!playing) return;

    let frame = requestAnimationFrame(function tick() {
      setElapsed(playerRef.current?.currentTime() ?? 0);
      frame = requestAnimationFrame(tick);
    });

    return () => cancelAnimationFrame(frame);
  }, [playing]);

  function toggle() {
    const player = playerRef.current;

    if (!player) return;

    if (player.paused()) void player.play();
    else player.pause();
  }

  /**
   * The bar seeks by fraction of its own width, held through the drag by
   * pointer capture — the pointer can wander off the strip mid-scrub without
   * the scrub letting go. `elapsed` is set here rather than left to the frame
   * loop above, which is not running on the paused clip that is the usual thing
   * to be scrubbing.
   */
  function seek(event: ReactPointerEvent<HTMLDivElement>) {
    const player = playerRef.current;

    if (!player || total <= 0) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));

    player.currentTime(fraction * total);
    setElapsed(fraction * total);
  }

  return (
    <div className="relative size-full">
      <Skeleton className={skeletonClass(revealed)} />

      {failed ? <Failure /> : null}

      {/* The host stays mounted through a failure, hidden under the notice
          rather than pulled out from under the player: unmounting it would
          leave video.js holding an element no longer in the document, with
          nothing to dispose it until the node itself goes. Disposal belongs
          to the effect's cleanup, which owns the player. */}
      {src ? (
        <div
          ref={host}
          className={cn("absolute inset-0", failed && "invisible", revealClass(revealed))}
        />
      ) : null}

      {src && !failed ? (
        <>
          {/*
           * The picture is the switch. Every player anyone has used answers a
           * press on the frame with play or pause, and on a tile this size that
           * is worth more than it is anywhere else: the button it saves aiming
           * at is thirty-six pixels wide at full zoom and proportionally less at
           * every zoom below it.
           *
           * Not a `<button>` and not in the tab order — the centre control below
           * is the same action, already named for the keyboard and for a screen
           * reader, and two tab stops per clip on a board of them is a worse
           * canvas than one. This layer is the mouse's shortcut to it, which is
           * also why it is `aria-hidden`.
           *
           * `onPointerDown` is deliberately left alone: that press is what
           * selects the node, and what drags it while the space bar is down.
           * Which is the same reason the toggle asks first — in drag mode a
           * press here opens a move, and a move that happens to end where it
           * began must not also have started the clip.
           */}
          <div
            aria-hidden
            className={cn(
              "absolute inset-0",
              // The one place on this canvas a pointer cursor is not a promise
              // being broken: at rest the node says `cursor-default` precisely
              // because nothing answers a plain click, and here something does.
              !dragMode && "cursor-pointer"
            )}
            onClick={() => {
              if (!dragMode) toggle();
            }}
          />

          {/*
           * The same action with a face on it, and the only half of the pair a
           * keyboard can reach.
           *
           * The reveal rides a wrapper rather than the button itself, for a
           * reason that is entirely mechanical: `transition-opacity` and the
           * button's own `transition-colors` are the same CSS property, and the
           * button merges its class list — so a fade added there does not join
           * the colour transition, it deletes it, and the button stops answering
           * hover. The wrapper shrink-wraps the button, so unlike a layer
           * spanning the frame it costs nothing to hit-test around — and it
           * being the container is also what lets the `has-` focus rule in
           * {@link TRANSPORT_ON_HOVER} see the button light up.
           */}
          <div
            className={cn(
              "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150",
              TRANSPORT_ON_HOVER
            )}
          >
            <Button
              icon
              shape="circle"
              size="lg"
              className="nodrag"
              aria-label={playing ? "Pause" : "Play"}
              // Same rule as the strip below: a control is not something to take
              // hold of, and without this a press here would drag the node out
              // from under it while the space bar is down.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggle}
            >
              <Icon name={playing ? "pause" : "play_arrow"} className="text-lg" />
            </Button>
          </div>

          <div
            className={cn(
              // The scrim is not decoration — it is what keeps white controls
              // legible over bright footage — so it lives and dies with them,
              // and what they both wait for is the pointer, playing or paused
              // alike. A paused tile used to keep the transport up permanently
              // so that there was always something visible to press; the cost
              // was a board of clips wearing a row of black bars across the part
              // of the picture nothing else was covering.
              //
              // What is left is where we are and how much is left — the two
              // things a still frame cannot say for itself. Play left for the
              // middle of the picture, and mute left with the autoplay that was
              // the only reason for it.
              //
              // The bar sits under them and hard against the bottom edge, where
              // a progress bar belongs: the only padding beneath it is the
              // seek's own grab area, so the strip reads as the clip's own
              // baseline rather than as a panel with a line floating in it.
              "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pt-6 transition-opacity duration-150",
              // A scrub holds the pointer through pointer capture, which is
              // exactly the gesture that carries it off the node — and hover is
              // not a thing to bet a held gesture on. Pinned while it lasts, so
              // the strip cannot fade out from under the thumb dragging it.
              scrubbing ? "pointer-events-auto opacity-100" : TRANSPORT_ON_HOVER
            )}
            // A control, not something to take hold of — same rule as the
            // toolbar: without this a press here would start dragging the
            // node while the space bar is down.
            onPointerDown={(event) => event.stopPropagation()}
          >
            {/* Counting up on the left, counting down on the right, and the
                sign is what says which is which — two bare timestamps side by
                side are a riddle. `tabular-nums` so neither of them shifts the
                other about as the digits change. */}
            <div className="flex items-baseline justify-between gap-2 text-[10px] leading-4 text-neutral-200 tabular-nums">
              <span>{clock(elapsed)}</span>
              <span>-{clock(total > 0 ? total - elapsed : 0)}</span>
            </div>

            {/* Padded well past the 4px it draws at, because a seek target is
                aimed at with a fingertip's precision, not a hairline's. The
                bar itself only displays; interpreting a press as a seek is
                this wrapper's job. */}
            <div
              className="nodrag cursor-pointer py-2"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setScrubbing(true);
                seek(event);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) seek(event);
              }}
              // Capture is what a scrub *is* here, so losing it is the one signal
              // that covers every way one ends — release, cancel, or the browser
              // taking it back — without three handlers agreeing on the same flag.
              onLostPointerCapture={() => setScrubbing(false)}
            >
              <Progress
                value={elapsed}
                max={total > 0 ? total : 1}
                aria-label="Playback position"
                // Both ends brightened from the wrapper's defaults: this bar
                // sits on footage behind a dark scrim, not on the player's
                // flat panel.
                trackClassName="bg-[rgba(218,220,224,0.25)]"
                indicatorClassName="bg-white/90"
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SoundBody({ data }: { data: GenerationNodeData }) {
  const audio = useRef<HTMLAudioElement>(null);

  const [revealed, setRevealed] = useState(false);
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(0);

  const src = assetSrc(data);
  const failed = data.status === "failed" || broken;
  const progress = total > 0 ? (elapsed / total) * 100 : 0;

  function toggle() {
    const element = audio.current;

    if (!element) return;

    if (element.paused) void element.play();
    else element.pause();
  }

  return (
    <div className="relative size-full">
      <Skeleton className={skeletonClass(revealed)} />

      {failed ? <Failure /> : null}

      {src && !failed ? (
        <div
          className={cn(
            // Opaque, and specifically the colour the skeleton rests at. A film
            // this thin over the canvas is not a surface — the dot grid reads
            // straight through the player, so the one node with no picture of
            // its own was also the one you could see the board through. Matching
            // the skeleton is what keeps the handover invisible: the fill does
            // not change when the placeholder leaves, only what sits on it.
            //
            // Two rows rather than one, and that is what the extra height is
            // for: a strip of transport controls is the same strip whatever it
            // is playing, so on a board of them there was no way to tell one
            // from another. The prompt is the only thing that says which is
            // which, and a node with no picture has room to show it.
            "absolute inset-0 flex flex-col justify-between bg-[#1a1b1d] p-3",
            revealClass(revealed)
          )}
        >
          <audio
            ref={audio}
            src={src}
            preload="metadata"
            onLoadedMetadata={(event) => {
              setTotal(event.currentTarget.duration);
              afterFirstPaint(() => setRevealed(true));
            }}
            onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setBroken(true)}
          />

          {/* Padded at both ends for the things floating over this row: `pe-20`
              is where the toolbar goes, and `ps-6` clears the type badge in the
              top-left corner — which is also why this row no longer carries a
              modality icon of its own; the badge says it for every node now. */}
          <div className="flex items-center gap-2 ps-6 pe-20">
            <span className="truncate text-[11px] leading-4 text-neutral-300">{data.prompt}</span>
          </div>

          <div className="flex items-center gap-3">
            <Button
              icon
              shape="circle"
              size="sm"
              className="nodrag shrink-0"
              aria-label={playing ? "Pause" : "Play"}
              onClick={toggle}
            >
              <Icon name={playing ? "pause" : "play_arrow"} className="text-sm" />
            </Button>

            <div className="h-1 min-w-0 flex-1 rounded-full bg-[rgba(218,220,224,0.12)]">
              <div
                className="h-full rounded-full bg-[rgba(218,220,224,0.55)]"
                style={{ width: `${progress}%` }}
              />
            </div>

            <span className="shrink-0 text-[10px] leading-4 text-neutral-400 tabular-nums">
              {clock(total > 0 ? total - elapsed : 0)}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What a blob says it is, turned into what the file should be called. Every
 * type the upload allowlist accepts is here, plus what the sample library
 * answers with; anything else falls back to the extension the URL carried.
 */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "audio/flac": "flac"
};

/**
 * What the result should be called on disk.
 *
 * An uploaded file already has a name — `prompt` is where it was put — and it
 * arrived with an extension of its own, so it is passed through untouched
 * rather than having a second one appended to it. Only the characters a file
 * system actually refuses are stripped either way, so a prompt written in
 * Chinese or Japanese still names its own file; an ASCII filter would turn
 * every one of them into the same empty string.
 */
function fileName(data: GenerationNodeData, url: string, type: string) {
  const stem =
    data.prompt
      .replace(/[\\/:*?"<>|]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || data.modality;

  if (data.source === "upload") return stem;

  // The serving URL carries no extension, so the blob's own type is what
  // names these — the pattern only finds one on the third-party URLs older
  // results still hold.
  const fromUrl = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(url)?.[1];

  return `${stem}.${fromUrl ?? EXTENSIONS[type] ?? "bin"}`;
}

/**
 * `name` is omitted for a cross-origin link, where the attribute would be
 * ignored anyway and the `Content-Disposition` on the response is what names
 * the file. Setting it there is not merely useless — a `download` the browser
 * refuses to honour turns the click into a navigation.
 */
function saveAs(href: string, name?: string) {
  const anchor = document.createElement("a");

  anchor.href = href;
  if (name !== undefined) anchor.download = name;
  anchor.rel = "noreferrer";
  anchor.click();
}

/**
 * The two things that can be done to a result, kept out of the way until the
 * pointer is on the node they belong to.
 *
 * It sits inside the node's top-right corner, over the result itself, which is
 * what the glass is for: a solid panel there would be a bite taken out of the
 * picture, where a translucent one reads as resting on it. The one node this is
 * tight on is a player, which is sixty pixels tall in total — the toolbar clears
 * it, but only just, and covers the elapsed time while the pointer is on it.
 *
 * `opacity-0` rather than unmounting, so both actions stay in the tab order and
 * in the accessibility tree on a node nobody is pointing at. A coarse pointer
 * has no hover to reveal them with, so it gets them outright.
 */
function NodeToolbar({ id, data }: { id: string; data: GenerationNodeData }) {
  const { deleteElements } = useReactFlow();

  const src = assetSrc(data);

  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  async function download() {
    if (!src || saving) return;

    setSaving(true);

    try {
      if (data.assetId) {
        // Same origin, so the serving route's own `?download=1` does all of
        // it: it answers with `Content-Disposition: attachment` named after
        // the row's filename, and the browser saves rather than navigates.
        // Nothing here has to read the bytes to rename them.
        saveAs(assetContentUrl(data.assetId, { filename: nodeFileName(data), download: true }));

        return;
      }

      // No asset row: a document from before the asset layer, whose `src` is
      // some other origin's URL. There the `download` attribute is ignored —
      // the browser navigates to the media instead of saving it, and what lands
      // on the disk is named after the URL — so the bytes are pulled through a
      // blob, which is same-origin by the time the anchor sees it.
      const response = await fetch(src);

      if (!response.ok) throw new Error(`Request failed: ${response.status}`);

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      saveAs(objectUrl, fileName(data, src, blob.type));

      // Not revoked on the next line: the click only *queues* the save, and a
      // URL revoked before the browser reads it downloads nothing at all.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch {
      // Reading another origin is that origin's to allow, and these samples are
      // not ours to configure. Opening the file is the most that can be done
      // from here, and it leaves the browser's own save one step away.
      window.open(src, "_blank", "noreferrer");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div
        /*
         * Quiet glass: one small blur and a white fill doing the actual work.
         * The heavy pane this used to be — low fill propped up by a stack of
         * brightness/contrast/saturation filters — processed the whole
         * backdrop to stay legible; here the fill is simply opaque enough
         * (three-fifths white) that black icons read over anything, including
         * the player's near-black body, and the blur is a hint that the
         * result continues underneath rather than an effect in its own right.
         *
         * Borderless on purpose: the strip's edge is its shadow, and the
         * question a border used to answer — where does one action end — is
         * answered by the hover state instead, which lights the hovered
         * action solid white.
         *
         * `top-2 right-2` where this used to need four. The inset was never a
         * taste — a corner handle reached fourteen pixels into the node, and
         * anything closer in than that overlapped it and lost the press to
         * whichever painted last. The handles have since given their inner
         * halves back, so nothing is claiming that corner any more and the strip
         * can sit where it looks right.
         *
         * It rides the canvas zoom like the rest of the node. Standing it off at
         * a fixed screen size is a change this has been through: it keeps the
         * icons hittable when the board is small, but the strip then grows over
         * a shrinking node until it is wearing it, which is worse than a control
         * that is simply too small to bother with at that zoom.
         */
        className={cn(
          "absolute top-2 right-2 flex items-center gap-0.5 rounded-xl bg-[rgba(255,255,255,0.6)] p-1 shadow-[0_2px_10px_rgba(0,0,0,0.12)] backdrop-blur-xs",
          REVEAL_ON_HOVER,
          "focus-within:pointer-events-auto focus-within:opacity-100 pointer-coarse:opacity-100"
        )}
        // The toolbar is a control, not something to take hold of: without this
        // a press on either button would start dragging the node out from under
        // it while the space bar is down.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          icon
          variant="ghost"
          size="sm"
          aria-label="Download"
          // `ghost` is built for a dark surface — grey text, and a hover that
          // lifts the fill towards white. On this light strip the text is
          // simply black, and the hover goes the rest of the way to solid
          // white: on a three-fifths-white ground, "lit up" reads as the one
          // action that is fully opaque.
          className="text-black hover:bg-white hover:text-black"
          // Nothing to save until the result has arrived.
          disabled={!src}
          pending={saving}
          onClick={() => void download()}
        >
          <Icon name="download" className="text-sm" />
        </Button>
        <Button
          icon
          variant="ghost"
          size="sm"
          aria-label="Delete"
          // The one action on this strip that cannot be taken back, and the
          // only reason it is not black like its neighbour.
          //
          // Not the app's own `red-400` though: that is destructive ink for the
          // dark menus it was picked on, and against this near-white glass it
          // measures 2.9:1 — a tint, not a warning. `red-600` is the darkest red
          // the theme exposes and reads at 4.8:1 on the solid white the hover
          // lifts it to.
          //
          // The strip is only three-fifths white, so over dark footage the ink
          // still has less to work with than black did. What carries the meaning
          // there is the glyph, which has not changed; the colour is the second
          // telling, and the confirm dialog is the third.
          className="text-red-600 hover:bg-white hover:text-red-600"
          onClick={() => setConfirming(true)}
        >
          <Icon name="delete" className="text-sm" />
        </Button>
      </div>

      {/* Deleting is the one action here with nothing behind it — the canvas
          keeps no history — so it is the one that asks first. */}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete this result?"
        description={
          // Only results the asset layer stored have a file to warn about;
          // older nodes hold third-party URLs this app never owned.
          data.assetId
            ? `“${data.prompt}” and its stored file will be deleted. This cannot be undone.`
            : `“${data.prompt}” will be removed from the canvas. This cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        error={null}
        pending={false}
        // No need to close it afterwards: the node this belongs to is what is
        // being removed, and it takes the dialog with it.
        onConfirm={() => void deleteElements({ nodes: [{ id }] })}
      />
    </>
  );
}

/**
 * A quarter arc hugging the corner it belongs to.
 *
 * React Flow centres a resize control *on* the corner — its stylesheet puts the
 * box at `left: 100%` and pulls it back by half its own size — so the node's
 * corner point sits at the middle of this 28×28 box, at (14, 14). One svg path
 * serves all four marks: a quarter turn at a time walks it round.
 *
 * The geometry inside the box is not fixed — see {@link cornerGeometry} — so
 * this table only says where each control sits and how far to turn the mark.
 */
const CORNERS = [
  { position: "bottom-right", turn: "" },
  { position: "bottom-left", turn: "rotate-90" },
  { position: "top-left", turn: "rotate-180" },
  { position: "top-right", turn: "-rotate-90" }
] as const satisfies readonly { position: ControlPosition; turn: string }[];

/** The node's corner radius — `rounded-xl` — in the node's own pixels. */
const NODE_RADIUS = 12;

/** Screen pixels of daylight between the node's edge and the mark. */
const HANDLE_GAP = 6;

/**
 * The corner marks and clips, derived against the zoom instead of assumed at
 * 1:1.
 *
 * The handle box holds its screen size below 1:1 (autoScale), but the node's
 * corner radius does not — on screen it is `12 × zoom`. Drawn for a 12px
 * radius regardless, the mark's bend crept toward the corner as the board
 * zoomed out (about `1 + 5·zoom` pixels of gap at the diagonal against a
 * constant six at the ends), which read as a mark pinched at its middle. So
 * everything is computed from the radius as it appears on screen, `r`: the
 * node's centre of curvature sits at `c = 14 − r`, the mark is concentric at
 * radius `r + gap` — the nested-card rule — and the gap is an even six at
 * every zoom. At 1:1 and above the whole handle scales with the node, so `r`
 * is simply 12 and the geometry is the one this file always had.
 *
 * The clips walk the node's true boundary: down the straight edge to the
 * tangent point at `c`, along the corner's arc between tangents, and out the
 * other straight edge — then round the box, enclosing everything except the
 * node's side. Because they share `r`, hit-testing follows the on-screen
 * curve at every zoom too.
 *
 * Quantized by the caller so a continuous pinch redraws the marks a handful
 * of times, not once per frame.
 */
function cornerGeometry(zoom: number) {
  const round = (value: number) => Number(value.toFixed(2));

  const r = round(NODE_RADIUS * Math.min(1, Math.max(zoom, 0.05)));
  const c = round(14 - r);
  const m = round(14 + r);
  const reach = round(r + HANDLE_GAP);

  return {
    arc: `M 20 ${c} A ${reach} ${reach} 0 0 1 ${c} 20`,
    clips: {
      "bottom-right": `path("M 14 0 L 14 ${c} A ${r} ${r} 0 0 1 ${c} 14 L 0 14 L 0 28 L 28 28 L 28 0 Z")`,
      "bottom-left": `path("M 14 0 L 14 ${c} A ${r} ${r} 0 0 0 ${m} 14 L 28 14 L 28 28 L 0 28 L 0 0 Z")`,
      "top-left": `path("M 14 28 L 14 ${m} A ${r} ${r} 0 0 1 ${m} 14 L 28 14 L 28 0 L 0 0 L 0 28 Z")`,
      "top-right": `path("M 14 28 L 14 ${m} A ${r} ${r} 0 0 0 ${c} 14 L 0 14 L 0 0 L 28 0 L 28 28 Z")`
    } satisfies Record<(typeof CORNERS)[number]["position"], string>
  };
}

/**
 * A player's height is pinned, so it gets two edge handles instead of four
 * corners. React Flow centres these the same way — `left: 0` or `left: 100%`,
 * halfway down — so the same 28×28 box works, and the cursor it hands out for
 * them is already the sideways one.
 *
 * The bar is offset to the outer half rather than sitting on the edge, because
 * the inner half is no longer a place a press lands: see {@link HANDLE_SIZE}.
 * A mark centred on a line where only one side of it answers is a mark that is
 * wrong half the time.
 */
const SIDES = [
  { position: "left", clip: "inset(0 50% 0 0)", bar: "left-1/4" },
  { position: "right", clip: "inset(0 0 0 50%)", bar: "left-3/4" }
] as const satisfies readonly { position: ControlPosition; clip: string; bar: string }[];

/**
 * How big a handle is on screen — and, because React Flow keeps it that size, at
 * every zoom level rather than only at 1:1.
 *
 * That last part is not ours and is not optional: `NodeResizeControl` ships with
 * `autoScale` on, and it scales a handle by `max(1 / zoom, 1)`. Zoom out and the
 * box grows in canvas pixels to hold its ground on screen. It is the right
 * instinct — a handle that shrank with the picture could not be taken hold of —
 * but React Flow also centres a control *on* the edge it belongs to, so half of
 * that growing box hangs over the inside of the node, and the box paints after
 * everything else in it.
 *
 * Which is the bug this file was opened for. At half zoom the left handle
 * reaches twenty-eight canvas pixels in; a player's play button starts at twelve
 * and is twenty-four wide, so two thirds of it is under the handle — and every
 * point of it, centre included, answers `ew-resize` instead of playing. By a
 * quarter zoom the reach is fifty-six and the button is gone entirely. The
 * corner handles did the same to a video's own transport controls.
 *
 * So each control gives its inner region back, by clip path — which governs
 * hit-testing as well as paint. On a side handle that is the inner half; on a
 * corner it is everything inside the node's *rounded* edge, so the boundary of
 * what still answers bends with the corner exactly as the mark does. What is
 * left hangs off the node, where there is nothing to be in front of.
 *
 * autoScale used to bring a caveat here — a clip drawn for the 1:1 radius
 * gave back a slightly wrong curve below it — but the corner geometry is now
 * derived against the zoom (see {@link cornerGeometry}), so the give-back
 * follows the edge as it actually appears at every scale.
 */
const HANDLE_SIZE = 28;

function ResizeHandles({ visual }: { visual: boolean }) {
  const dragMode = useContext(DragModeContext);

  // Quantized to twentieths so a continuous zoom gesture re-derives the
  // corner geometry a handful of times across its whole travel; capped at 1
  // because above 1:1 the handle scales with the node and needs no help.
  const zoom = useStore((state) => Math.min(1, Math.ceil(state.transform[2] * 20) / 20));

  /**
   * The toolbar reveals on plain hover; these wait for drag mode as well.
   * Resizing is a move-things-around gesture, so it lives behind the same
   * space bar that dragging does — a pointer that cannot drag should not be
   * shown handles either. Touch keeps its standing exception: no space bar,
   * no hover, so its handles stay reachable without being shown.
   */
  const reveal = cn(
    "pointer-events-none opacity-0 transition-opacity duration-150",
    "pointer-coarse:pointer-events-auto",
    dragMode && "group-hover:pointer-events-auto group-hover:opacity-100"
  );

  // Inline rather than through `className`: React Flow styles its own handle
  // with two classes, which outranks a utility class, and what is wanted here is
  // not a small square with a border but nothing at all behind the mark.
  const box = {
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: "transparent",
    border: "none",
    borderRadius: 0
  };

  const bounds = {
    minWidth: 160,
    maxWidth: 1280,
    // Media keeps its shape — a stretched frame is a lie about what was
    // generated. A player has no shape to keep, but it does have a height that
    // means something, so that is pinned and only the width moves.
    minHeight: visual ? 90 : SOUND_HEIGHT,
    maxHeight: visual ? 1280 : SOUND_HEIGHT
  };

  if (!visual) {
    return (
      <>
        {SIDES.map(({ position, clip, bar }) => (
          <NodeResizeControl
            key={position}
            position={position}
            {...bounds}
            style={{ ...box, clipPath: clip }}
            className={reveal}
          >
            {/* A bar rather than an arc. Four corner arcs promise a box that can
                be pulled in both directions, and this one cannot: it offers the
                one axis it can actually move on. */}
            <span
              aria-hidden
              className={cn(
                "absolute top-1/2 h-6 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500",
                bar
              )}
            />
          </NodeResizeControl>
        ))}
      </>
    );
  }

  const { arc, clips } = cornerGeometry(zoom);

  return (
    <>
      {CORNERS.map(({ position, turn }) => (
        <NodeResizeControl
          key={position}
          position={position}
          keepAspectRatio
          {...bounds}
          style={{ ...box, clipPath: clips[position] }}
          className={reveal}
        >
          {/* The outer card's corner, concentric with the node's own round at
              whatever radius the zoom leaves it — see `cornerGeometry` for
              the derivation and why it cannot be a constant. */}
          <svg viewBox="0 0 28 28" aria-hidden className={cn("size-full", turn)}>
            <path
              d={arc}
              fill="none"
              className="stroke-blue-500"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </NodeResizeControl>
      ))}
    </>
  );
}

/** Opaque for the reason the player is: a node you can see the canvas through is not a node. */
/**
 * What a node says when there is nothing to show, and — when this tab can do
 * something about it — the one action worth offering there.
 *
 * On one line rather than stacked, because the sound node is 88px tall and a
 * second row would not fit in it. `nodrag` and the stopped propagation are
 * what keep the press from reaching React Flow, which would otherwise read it
 * as picking the node up.
 */
function Failure() {
  const retry = useContext(RetryContext);

  return (
    <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[#1a1b1d] text-[11px] leading-4 text-neutral-400">
      <Icon name="error" className="text-sm" />
      Could not load
      {retry ? (
        <button
          type="button"
          className="nodrag cursor-pointer underline underline-offset-2 hover:text-neutral-200"
          onClick={(event) => {
            event.stopPropagation();
            retry();
          }}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return "--:--";

  const whole = Math.max(0, Math.round(seconds));

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Declared once, out here: React Flow compares this object by identity and
 * rebuilds every node type when it changes.
 */
export const GENERATION_NODE_TYPES: NodeTypes = { generation: GenerationNodeView };
