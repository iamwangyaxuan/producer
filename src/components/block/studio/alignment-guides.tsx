import { useStore } from "@xyflow/react";
import type { Node, NodePositionChange, XYPosition } from "@xyflow/react";

/**
 * How close two edges have to come before they are treated as meant to line up.
 * Measured in flow units, so it is a constant distance on the canvas rather than
 * on screen — a guide should not get easier to hit by zooming in.
 */
const THRESHOLD = 6;

export interface Alignment {
  /** Flow x of the guide to draw, if the drag lined up on that axis. */
  vertical?: number;
  /** Flow y of the guide to draw. */
  horizontal?: number;
  /** The position to move to, with only the axes that actually snapped set. */
  position: Partial<XYPosition>;
}

interface Edges {
  near: number;
  far: number;
  centre: number;
}

function edges(start: number, length: number): Edges {
  return { near: start, far: start + length, centre: start + length / 2 };
}

/**
 * Every way two boxes can be said to line up on one axis, as (the edge being
 * dragged, the edge it would meet, where the box has to sit for that to happen).
 * Near-to-far and far-to-near are in here as well as like-to-like, so nodes
 * butted up against each other snap too, not only nodes in a column.
 */
function candidates(a: Edges, b: Edges, length: number) {
  return [
    { from: a.near, to: b.near, at: b.near },
    { from: a.near, to: b.far, at: b.far },
    { from: a.far, to: b.far, at: b.far - length },
    { from: a.far, to: b.near, at: b.near - length },
    { from: a.centre, to: b.centre, at: b.centre - length / 2 }
  ];
}

function measure(node: Node) {
  return {
    width: node.measured?.width ?? 0,
    height: node.measured?.height ?? 0
  };
}

/**
 * What the dragged node should snap to, and which guides to draw for it.
 *
 * Only the closest match on each axis wins, so a node between two others does
 * not jump to whichever happened to be compared last, and the two axes are
 * decided independently — lining up a left edge should not drag the node
 * vertically as a side effect.
 */
export function alignmentFor(change: NodePositionChange, nodes: readonly Node[]): Alignment {
  const dragged = nodes.find((node) => node.id === change.id);
  const result: Alignment = { position: {} };

  if (!dragged || !change.position) return result;

  const { width, height } = measure(dragged);
  const horizontalEdges = edges(change.position.x, width);
  const verticalEdges = edges(change.position.y, height);

  let closestX = THRESHOLD;
  let closestY = THRESHOLD;

  for (const other of nodes) {
    if (other.id === dragged.id) continue;

    const size = measure(other);

    for (const option of candidates(horizontalEdges, edges(other.position.x, size.width), width)) {
      const gap = Math.abs(option.from - option.to);

      if (gap < closestX) {
        closestX = gap;
        result.position.x = option.at;
        result.vertical = option.to;
      }
    }

    for (const option of candidates(verticalEdges, edges(other.position.y, size.height), height)) {
      const gap = Math.abs(option.from - option.to);

      if (gap < closestY) {
        closestY = gap;
        result.position.y = option.at;
        result.horizontal = option.to;
      }
    }
  }

  return result;
}

export interface ResizeAlignment {
  /** Flow x of the guide to draw, if the edge being pulled met one. */
  vertical?: number;
  /** Flow y of the guide. */
  horizontal?: number;
  /** Both are set together, and only when an edge actually met something. */
  position?: XYPosition;
  size?: { width: number; height: number };
}

/**
 * The edge a resize is pulling on one axis, and the one it is pulling against.
 *
 * A corner handle moves exactly one edge per axis and leaves the opposite one
 * where it is. Which is which follows from the position: React Flow only sends a
 * new one when the near edge is what moved, so a start that has not changed is
 * itself the anchor.
 */
function pulledEdge(start: number, length: number, nextStart: number, nextLength: number) {
  const near = nextStart !== start;

  return {
    at: near ? nextStart : nextStart + nextLength,
    anchor: near ? start + length : start,
    near,
    /** An axis nothing happened on has no edge to line up and no guide to draw. */
    moved: near || nextLength !== length
  };
}

/** The closest edge of anything else, if one is close enough to be meant. */
function nearestEdge(at: number, others: readonly Edges[]) {
  let best: { to: number; distance: number } | undefined;

  for (const other of others) {
    for (const candidate of [other.near, other.far, other.centre]) {
      const distance = Math.abs(at - candidate);

      if (distance < THRESHOLD && (!best || distance < best.distance)) {
        best = { to: candidate, distance };
      }
    }
  }

  return best;
}

/**
 * What a resize should snap to, and the guide to draw for it.
 *
 * Exactly one edge is honoured per frame — the nearest of the two being pulled.
 * A node that keeps its shape has a single degree of freedom, so moving one edge
 * moves the other three with it: answering both axes at once would be two
 * answers to one question, and they would disagree. Which one is being asked is
 * settled by whichever edge is closer to meeting something.
 *
 * `keepRatio` is what the resize control itself was given. When it is set the
 * other dimension is derived from the shape the node already had, so the snap
 * cannot quietly stretch a picture; when it is not, the axis that did not move
 * is left exactly as it came in — which is what keeps a player's fixed height
 * fixed.
 */
export function resizeAlignmentFor(
  node: Node,
  next: { position: XYPosition; width: number; height: number },
  nodes: readonly Node[],
  keepRatio: boolean
): ResizeAlignment {
  const result: ResizeAlignment = {};
  const { width, height } = measure(node);

  if (!width || !height) return result;

  const x = pulledEdge(node.position.x, width, next.position.x, next.width);
  const y = pulledEdge(node.position.y, height, next.position.y, next.height);

  const others = nodes.filter((other) => other.id !== node.id);

  const onX = x.moved
    ? nearestEdge(
        x.at,
        others.map((other) => edges(other.position.x, measure(other).width))
      )
    : undefined;
  const onY = y.moved
    ? nearestEdge(
        y.at,
        others.map((other) => edges(other.position.y, measure(other).height))
      )
    : undefined;

  const horizontal = onX && (!onY || onX.distance <= onY.distance);
  const match = horizontal ? onX : onY;
  const edge = horizontal ? x : y;

  if (!match) return result;

  // Measured from the anchor, so the edge that is not being pulled stays exactly
  // where it is — which is the whole reason the anchor was worked out.
  const length = edge.near ? edge.anchor - match.to : match.to - edge.anchor;

  // A snap that would turn the node inside out is not a snap anybody asked for.
  if (length < 1) return result;

  const ratio = width / height;

  const size = horizontal
    ? { width: length, height: keepRatio ? length / ratio : next.height }
    : { width: keepRatio ? length * ratio : next.width, height: length };

  result.size = size;
  result.position = {
    x: x.near ? x.anchor - size.width : node.position.x,
    y: y.near ? y.anchor - size.height : node.position.y
  };

  if (horizontal) result.vertical = match.to;
  else result.horizontal = match.to;

  return result;
}

/** One gap the drag made equal to another, in flow coordinates. */
export interface Span {
  /** The axis the gap is measured along. */
  axis: "x" | "y";
  /** The gap's two ends along `axis`. */
  from: number;
  to: number;
  /** Where to draw it on the other axis. */
  at: number;
}

export interface Spacing {
  /** The gaps that were made equal: a pair when something matched, else empty. */
  spans: Span[];
  /** The position to move to, with only the axes that actually snapped set. */
  position: Partial<XYPosition>;
}

/**
 * A box on the axis a gap is measured along, plus its extent on the other one.
 *
 * That second pair is what decides whether a gap is a gap at all. Two nodes side
 * by side have a horizontal gap between them; one of them and a node three rows
 * down have a horizontal *distance*, and matching that against a real gap would
 * draw a guide across empty canvas to explain a coincidence.
 */
interface Box {
  near: number;
  far: number;
  crossNear: number;
  crossFar: number;
}

/** Whether the two overlap on the axis the gap is *not* measured along. */
function sharesBand(a: Box, b: Box) {
  return Math.min(a.crossFar, b.crossFar) > Math.max(a.crossNear, b.crossNear);
}

/** The box that ends closest to `at` without passing it. */
function lastBefore(boxes: readonly Box[], at: number) {
  let best: Box | undefined;

  for (const box of boxes) {
    if (box.far <= at && (!best || box.far > best.far)) best = box;
  }

  return best;
}

/** The box that starts closest after `at`. */
function firstAfter(boxes: readonly Box[], at: number) {
  let best: Box | undefined;

  for (const box of boxes) {
    if (box.near >= at && (!best || box.near < best.near)) best = box;
  }

  return best;
}

/** Where the dragged box has to sit on this axis, and the two gaps that says are equal. */
interface Match {
  at: number;
  gaps: [from: number, to: number][];
}

/**
 * The two ways a drag can be asking for even spacing on one axis.
 *
 * Both are decided from the dragged node's immediate neighbours rather than from
 * every pair on the canvas. Spacing is a local claim — it is about the run of
 * things you are placing something into — and searching wider only finds
 * coincidences on a busy canvas, which show up as guides pointing at nodes
 * nowhere near the one being moved.
 *
 * Neither case can move the node further than the threshold: the between-two
 * case moves it by half the difference of the two gaps, and the continuing case
 * by the whole difference. So a match tidies a near miss and never yanks
 * anything across the canvas.
 */
function spacingOn(dragged: Box, others: readonly Box[], length: number): Match | undefined {
  const run = others.filter(
    (box) =>
      sharesBand(dragged, box) &&
      // A box the drag is currently over is not spaced from it at all, and the
      // searches below assume every box is wholly to one side.
      (box.far <= dragged.near || box.near >= dragged.far)
  );

  const previous = lastBefore(run, dragged.near);
  const next = firstAfter(run, dragged.far);

  // Bounded on both sides: the two gaps are made equal, which is what dropping
  // something *between* two things is asking for.
  if (previous && next) {
    const before = dragged.near - previous.far;
    const after = next.near - dragged.far;

    if (before > 0 && after > 0 && Math.abs(before - after) <= THRESHOLD) {
      const at = (previous.far + next.near - length) / 2;

      return {
        at,
        gaps: [
          [previous.far, at],
          [at + length, next.near]
        ]
      };
    }
  }

  // Otherwise the drag is continuing a run, and the gap to repeat is the one
  // that run already has. Reading it off the pair *behind* the neighbour is what
  // makes this "the same again" rather than "some spacing seen somewhere".
  if (previous) {
    const anchor = lastBefore(run, previous.near);

    if (anchor) {
      const step = previous.near - anchor.far;
      const gap = dragged.near - previous.far;

      if (step > 0 && Math.abs(gap - step) <= THRESHOLD) {
        const at = previous.far + step;

        return {
          at,
          gaps: [
            [anchor.far, previous.near],
            [previous.far, at]
          ]
        };
      }
    }
  }

  if (next) {
    const anchor = firstAfter(run, next.far);

    if (anchor) {
      const step = anchor.near - next.far;
      const gap = next.near - dragged.far;

      if (step > 0 && Math.abs(gap - step) <= THRESHOLD) {
        const at = next.near - step - length;

        return {
          at,
          gaps: [
            [at + length, next.near],
            [next.far, anchor.near]
          ]
        };
      }
    }
  }

  return undefined;
}

/** Every other node as a box on each axis, ready to be searched either way round. */
function boxesAround(nodes: readonly Node[], exclude: string) {
  const along: { x: Box[]; y: Box[] } = { x: [], y: [] };

  for (const node of nodes) {
    if (node.id === exclude) continue;

    const { width, height } = measure(node);
    const { x, y } = node.position;

    along.x.push({ near: x, far: x + width, crossNear: y, crossFar: y + height });
    along.y.push({ near: y, far: y + height, crossNear: x, crossFar: x + width });
  }

  return along;
}

/**
 * What the dragged node should snap to for its gaps to match the ones already
 * there, and which of those gaps to draw.
 *
 * Runs after {@link alignmentFor} and defers to it: an axis an edge already
 * snapped on is spoken for. Lining an edge up is the more specific of the two
 * claims — it names one coordinate exactly, where matching a gap only says two
 * distances came out similar — so spacing takes the axes alignment left alone
 * rather than fighting it for them. The two do coexist, on different axes: a row
 * of nodes is usually flush along one and evenly spaced along the other, which
 * is exactly one guide of each.
 */
export function spacingFor(
  change: NodePositionChange,
  nodes: readonly Node[],
  alignment: Alignment
): Spacing {
  const dragged = nodes.find((node) => node.id === change.id);
  const result: Spacing = { spans: [], position: {} };

  if (!dragged || !change.position) return result;

  const { width, height } = measure(dragged);

  // Measured from where the node is about to land rather than from where the
  // pointer is: alignment has already had its say, and a gap read off a position
  // that is about to move is a gap drawn a few pixels out from the node it
  // belongs to.
  const x = alignment.position.x ?? change.position.x;
  const y = alignment.position.y ?? change.position.y;

  const others = boxesAround(nodes, dragged.id);

  if (alignment.position.x === undefined) {
    const match = spacingOn(
      { near: x, far: x + width, crossNear: y, crossFar: y + height },
      others.x,
      width
    );

    if (match) {
      result.position.x = match.at;
      // Every span of a match is drawn on one line, through the middle of the
      // node being placed. Two bars at the same height can be compared at a
      // glance; two at different heights are just two marks.
      result.spans.push(
        ...match.gaps.map(([from, to]) => ({ axis: "x" as const, from, to, at: y + height / 2 }))
      );
    }
  }

  if (alignment.position.y === undefined) {
    const match = spacingOn(
      { near: y, far: y + height, crossNear: x, crossFar: x + width },
      others.y,
      height
    );

    if (match) {
      const centre = (result.position.x ?? x) + width / 2;

      result.position.y = match.at;
      result.spans.push(
        ...match.gaps.map(([from, to]) => ({ axis: "y" as const, from, to, at: centre }))
      );
    }
  }

  return result;
}

export interface Guides {
  /** Flow x of the edge guide to draw, if the drag lined up on that axis. */
  vertical?: number;
  /** Flow y of the edge guide. */
  horizontal?: number;
  /** Gaps the drag made equal to each other. */
  spans?: Span[];
}

/**
 * The one colour on this canvas that is not a shade of the canvas. Everything
 * else here is drawn in the same near-white at some opacity, which is what a
 * guide cannot afford to be: it is laid over media of every brightness, and a
 * translucent grey line vanishes against a pale photograph exactly when it is
 * being relied on. Full opacity, and a hue nothing else uses.
 */
const GUIDE_CLASS = "absolute bg-blue-500";

/**
 * The ticks that close off each end of a measured gap. Without them a short bar
 * and a long one are hard to tell apart at a glance, which is the one comparison
 * a spacing guide exists to make.
 */
const TICK_CLASS = {
  x: [
    "top-1/2 left-0 h-[7px] w-px -translate-y-1/2",
    "top-1/2 right-0 h-[7px] w-px -translate-y-1/2"
  ],
  y: [
    "top-0 left-1/2 h-px w-[7px] -translate-x-1/2",
    "bottom-0 left-1/2 h-px w-[7px] -translate-x-1/2"
  ]
} as const;

/**
 * The guides themselves, drawn at the flow coordinates that matched: edge guides
 * across the whole canvas, spacing guides only across the gap they measure.
 *
 * Reading the viewport transform out of the store rather than placing these
 * inside the transformed viewport keeps every line one pixel wide at every zoom
 * level — a guide that thickens as you zoom in stops reading as a reference and
 * starts reading as content. It is also what keeps the ticks the same size as
 * the gap they cap changes length.
 *
 * Both kinds are drawn in the same colour on purpose. The shapes already say
 * which is which — one runs off both edges of the screen, the other stops at two
 * ticks — and a second colour would be a piece of vocabulary to learn for a
 * distinction the drawing has already made.
 */
export default function AlignmentGuides({ vertical, horizontal, spans }: Guides) {
  const [offsetX, offsetY, zoom] = useStore((state) => state.transform);

  if (vertical === undefined && horizontal === undefined && !spans?.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-4 overflow-hidden">
      {vertical !== undefined ? (
        <div
          className={`${GUIDE_CLASS} top-0 bottom-0 w-px`}
          style={{ left: vertical * zoom + offsetX }}
        />
      ) : null}
      {horizontal !== undefined ? (
        <div
          className={`${GUIDE_CLASS} right-0 left-0 h-px`}
          style={{ top: horizontal * zoom + offsetY }}
        />
      ) : null}
      {spans?.map((span) => (
        <SpacingSpan
          key={`${span.axis}:${span.from}:${span.to}`}
          span={span}
          zoom={zoom}
          offsetX={offsetX}
          offsetY={offsetY}
        />
      ))}
    </div>
  );
}

function SpacingSpan({
  span,
  zoom,
  offsetX,
  offsetY
}: {
  span: Span;
  zoom: number;
  offsetX: number;
  offsetY: number;
}) {
  const length = (span.to - span.from) * zoom;

  // A gap with nothing in it has nothing to show, and its two ticks would land
  // on top of each other and read as a stray mark.
  if (length < 1) return null;

  const box =
    span.axis === "x"
      ? {
          left: span.from * zoom + offsetX,
          top: span.at * zoom + offsetY,
          width: length,
          height: 1
        }
      : {
          left: span.at * zoom + offsetX,
          top: span.from * zoom + offsetY,
          width: 1,
          height: length
        };

  return (
    <div className={GUIDE_CLASS} style={box}>
      {TICK_CLASS[span.axis].map((tick) => (
        <span key={tick} className={`${GUIDE_CLASS} ${tick}`} />
      ))}
    </div>
  );
}
