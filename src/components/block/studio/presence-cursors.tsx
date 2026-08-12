import { useStore } from "@xyflow/react";

import type { CanvasPeer } from "#/components/block/studio/use-canvas-collab";

/**
 * Everyone else's pointer, drawn where they actually are on the canvas.
 *
 * Cursors arrive in flow coordinates and are mapped to the screen with the
 * viewport transform — the same arrangement the alignment guides use, and for
 * the same reason: content inside React Flow's transformed viewport scales
 * with the zoom, and a cursor that grows as you zoom in stops reading as a
 * person and starts reading as a shape on the board. Out here it stays
 * pointer-sized at every zoom level.
 *
 * The short transform transition is what makes remote movement watchable: the
 * stream is thinned to one position every few dozen milliseconds, and easing
 * between arrivals turns a stutter of teleports into a glide.
 */
export default function PresenceCursors({
  peers,
  selfClientId
}: {
  peers: CanvasPeer[];
  selfClientId: number | null;
}) {
  const [offsetX, offsetY, zoom] = useStore((state) => state.transform);

  const others = peers.filter((peer) => peer.clientId !== selfClientId && peer.cursor);

  if (others.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-5 overflow-hidden">
      {others.map((peer) => (
        <div
          key={peer.clientId}
          className="absolute top-0 left-0 transition-transform duration-100 ease-linear will-change-transform"
          style={{
            transform: `translate(${peer.cursor!.x * zoom + offsetX}px, ${peer.cursor!.y * zoom + offsetY}px)`
          }}
        >
          <CursorArrow color={peer.user.color} />
          {/* Offset to sit under the arrow's tip, the way every design tool
              places the name — over the pointer it would hide what the person
              is pointing at. */}
          <span
            className="absolute top-4.5 left-3 max-w-40 truncate rounded-md px-1.5 py-0.5 text-[10px] leading-4 font-medium whitespace-nowrap text-white shadow-[0_2px_8px_rgba(0,0,0,0.35)]"
            style={{ backgroundColor: peer.user.color }}
          >
            {peer.user.name}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The classic tilted pointer, with a dark outline so it survives pale media. */
function CursorArrow({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">
      <path
        d="M2 1.5 L13.5 8.2 L8.3 9.4 L5.4 14.2 Z"
        fill={color}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
