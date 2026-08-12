import { NodeResizeControl, useReactFlow } from "@xyflow/react";
import type { ControlPosition, Node, NodeProps, NodeTypes } from "@xyflow/react";
import { createContext, useContext, useRef, useState } from "react";
import { cn } from "tailwind-variants";

import { ConfirmDialog } from "#/components/block/project-dialogs";
import type { Modality } from "#/components/block/studio/ai-composer";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Skeleton from "#/components/ui/skeleton";
import { aspectRatioValue } from "#/lib/sample-media";

export type GenerationStatus = "pending" | "ready" | "failed";

export interface GenerationNodeData extends Record<string, unknown> {
  modality: Modality;
  prompt: string;
  model: string;
  aspectRatio?: string;
  status: GenerationStatus;
  src?: string;
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

/** One width for every node, so a canvas of mixed results still reads as a column of cards. */
export const NODE_WIDTH = 320;

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
 * top of. The dimensions are known here anyway: the width is fixed and the
 * height follows from the ratio the result was asked for.
 */
export function nodeSize(data: GenerationNodeData) {
  if (data.modality === "voice" || data.modality === "music") {
    return { width: NODE_WIDTH, height: SOUND_HEIGHT };
  }

  const ratio = aspectRatioValue(data.aspectRatio) ?? 1;

  return { width: NODE_WIDTH, height: Math.round(NODE_WIDTH / ratio) };
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
          // picked, without giving every node an edge it does not need.
          //
          // The outline is always here and always transparent, and only its
          // hover colour comes and goes. Hanging the whole outline off the
          // modifier instead is what made every node flash white the moment the
          // key went down: `outline-width` and `outline-style` are not in the
          // transition, so they landed at once, while `outline-color` had to
          // travel to `transparent` from whatever it had been computing to
          // without an outline utility — `currentColor`, which on this canvas is
          // the white the text inherits. Two frames of a white frame on every
          // node, then a fade to nothing.
          "size-full overflow-hidden rounded-2xl outline-2 outline-offset-2 outline-transparent transition-[outline-color] duration-150",
          // Only while the modifier is held: an outline that appeared on hover
          // at all times would be promising something a plain pointer cannot do.
          // The same blue the drag guides are drawn in, and for the same reason:
          // this outline hugs the result two pixels out, so a translucent grey
          // one disappears against any pale image it happens to land on.
          dragMode && "hover:outline-blue-500",
          selected && "ring-1 ring-[rgba(218,220,224,0.35)]"
        )}
      >
        {visual ? <VisualBody data={data} /> : <SoundBody data={data} />}
      </div>

      <NodeToolbar id={id} data={data} />

      <ResizeHandles visual={visual} />
    </div>
  );
}

function VisualBody({ data }: { data: GenerationNodeData }) {
  const [revealed, setRevealed] = useState(false);
  const [broken, setBroken] = useState(false);

  const failed = data.status === "failed" || broken;

  return (
    // Fills whatever the node has been sized to. The ratio still decides that
    // size at creation — see `nodeSize` — so the skeleton is the shape of the
    // picture before the picture exists, and nothing reflows when it lands.
    <div className="relative size-full">
      <Skeleton className={skeletonClass(revealed)} />

      {failed ? <Failure /> : null}

      {data.src && !failed ? (
        data.modality === "image" ? (
          <img
            src={data.src}
            alt={data.prompt}
            // Browsers let an image be dragged out of the page on its own, which
            // puts a ghost under the cursor and takes the pointer away from the
            // node drag that was actually starting.
            draggable={false}
            onLoad={() => afterFirstPaint(() => setRevealed(true))}
            onError={() => setBroken(true)}
            className={cn("absolute inset-0 size-full object-cover", revealClass(revealed))}
          />
        ) : (
          <video
            src={data.src}
            // Still plays itself, because a canvas of stills that happen to move
            // is what a board of clips should look like at a glance. `muted` is
            // not a preference — no browser will autoplay without it — and the
            // controls are how the sound gets turned back on.
            autoPlay
            muted
            loop
            playsInline
            // The browser's own bar rather than one built here: it brings
            // scrubbing, volume, fullscreen, keyboard access and the platform's
            // own look with it, and none of that is worth reimplementing for a
            // clip sitting on a board.
            controls
            // The toolbar above the node already offers the download, and it
            // hands over a named file rather than whatever the URL ends in.
            controlsList="nodownload"
            // Deliberately no `nodrag`: it stops an element from starting a node
            // drag, and this one covers the node completely, so marking it would
            // leave the whole tile with nowhere to take hold of. The controls do
            // not need protecting from that, because the two gestures are never
            // the same one — a node only moves while the space bar is held, and
            // nobody scrubs a timeline with it down.
            className={cn("absolute inset-0 size-full object-cover", revealClass(revealed))}
            onLoadedData={() => afterFirstPaint(() => setRevealed(true))}
            onError={() => setBroken(true)}
          />
        )
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

      {data.src && !failed ? (
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
            src={data.src}
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

          {/* `pe-20` is where the toolbar goes. It floats over the picture on a
              node that has one, but here there is nothing to float over — so the
              row it lands on gives up its tail instead, and the prompt truncates
              before it reaches rather than sliding underneath. */}
          <div className="flex items-center gap-2 pe-20">
            <Icon
              name={data.modality === "music" ? "music_note" : "graphic_eq"}
              className="shrink-0 text-sm text-neutral-500"
            />
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
 * What a blob says it is, turned into what the file should be called. Only the
 * types the sample library actually answers with are in here; anything else
 * falls back to the extension the URL already carried.
 */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav"
};

/**
 * The prompt, made safe to write to a disk.
 *
 * Only the characters a file system actually refuses are stripped, so a prompt
 * written in Chinese or Japanese still names its own file — running it through
 * an ASCII filter would turn every one of them into the same empty string.
 */
function fileName(data: GenerationNodeData, url: string, type: string) {
  const stem =
    data.prompt
      .replace(/[\\/:*?"<>|]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || data.modality;

  const fromUrl = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(url)?.[1];

  return `${stem}.${fromUrl ?? EXTENSIONS[type] ?? "bin"}`;
}

function saveAs(href: string, name: string) {
  const anchor = document.createElement("a");

  anchor.href = href;
  anchor.download = name;
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

  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  async function download() {
    const src = data.src;

    if (!src || saving) return;

    setSaving(true);

    try {
      // Fetched rather than linked. These files come from other origins, and
      // there the `download` attribute is ignored outright: the browser
      // navigates to the media instead of saving it, and what lands on the disk
      // is named after the URL. A blob is same-origin by the time the anchor
      // sees it, so both the save and the name survive.
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
         * Glass, and thin enough to be glass: the fill is under half opaque and
         * the blur behind it is what makes the icons readable, rather than a
         * near-solid panel that would only be borrowing the word. The saturation
         * bump is the rest of it — a blur alone turns a colourful picture to
         * grey haze, and it is the colour bleeding through that says there is
         * something *behind* this rather than a hole cut in the node.
         *
         * `top-4 right-4` is a clearance rather than a taste. The corner handle
         * is centred *on* the corner, so it reaches fourteen pixels into the
         * node; anything inset less than that overlaps it, and whichever of the
         * two paints last takes the press.
         */
        className="absolute top-4 right-4 flex items-center gap-0.5 rounded-xl border border-[rgba(218,220,224,0.12)] bg-[rgba(22,23,24,0.5)] p-1 opacity-0 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl backdrop-saturate-150 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
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
          // A step brighter than `ghost` rests at. This sits over the result
          // rather than over the canvas, and the result can be a white sky.
          className="text-neutral-100"
          // Nothing to save until the result has arrived.
          disabled={!data.src}
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
          className="text-red-400 hover:bg-red-500/15 hover:text-red-300"
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
        description={`“${data.prompt}” will be removed from the canvas. This cannot be undone.`}
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
 * A quarter circle curving around the corner it belongs to.
 *
 * React Flow centres a resize control *on* the corner — its stylesheet puts the
 * box at `left: 100%` and pulls it back by half its own size — so the corner
 * sits at the middle of this 28×28 box, at (14, 14).
 *
 * The arc is swung from a centre of curvature *inside* the node, at (4, 4), with
 * a radius long enough to carry it past the corner: 18 against the 14.1 that
 * separates the two, so every point of it clears the node by a few pixels. That
 * is what makes it a handle sitting proud of the corner rather than a shape
 * drawn on the node — and it is what keeps the hover outline, which hugs the
 * node two pixels out, from enclosing the handles instead of the result.
 *
 * One path serves all four: a quarter turn at a time walks it round.
 */
const CORNERS = [
  { position: "bottom-right", turn: "" },
  { position: "bottom-left", turn: "rotate-90" },
  { position: "top-left", turn: "rotate-180" },
  { position: "top-right", turn: "-rotate-90" }
] as const satisfies readonly { position: ControlPosition; turn: string }[];

/**
 * A player's height is pinned, so it gets two edge handles instead of four
 * corners. React Flow centres these the same way — `left: 0` or `left: 100%`,
 * halfway down — so the same 28×28 box works, and the cursor it hands out for
 * them is already the sideways one.
 */
const SIDES = ["left", "right"] as const satisfies readonly ControlPosition[];

function ResizeHandles({ visual }: { visual: boolean }) {
  // Inline rather than through `className`: React Flow styles its own handle
  // with two classes, which outranks a utility class, and what is wanted here is
  // not a small square with a border but nothing at all behind the mark.
  const box = {
    width: 28,
    height: 28,
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

  const reveal = "opacity-0 transition-opacity duration-150 group-hover:opacity-100";

  if (!visual) {
    return (
      <>
        {SIDES.map((position) => (
          <NodeResizeControl
            key={position}
            position={position}
            {...bounds}
            style={box}
            className={cn(reveal, "flex items-center justify-center")}
          >
            {/* A bar rather than an arc. Four corner arcs promise a box that can
                be pulled in both directions, and this one cannot: it offers the
                one axis it can actually move on. */}
            <span aria-hidden className="h-6 w-[3px] rounded-full bg-[rgba(218,220,224,0.9)]" />
          </NodeResizeControl>
        ))}
      </>
    );
  }

  return (
    <>
      {CORNERS.map(({ position, turn }) => (
        <NodeResizeControl
          key={position}
          position={position}
          keepAspectRatio
          {...bounds}
          style={box}
          className={reveal}
        >
          <svg viewBox="0 0 28 28" aria-hidden className={cn("size-full", turn)}>
            <path
              d="M22 4 A 18 18 0 0 1 4 22"
              fill="none"
              stroke="rgba(218,220,224,0.9)"
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
function Failure() {
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-2 bg-[#1a1b1d] text-[11px] leading-4 text-neutral-400">
      <Icon name="error" className="text-sm" />
      Could not load
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
