import type { CanvasPeer } from "#/components/block/studio/use-canvas-collab";
import type { PresenceUser } from "#/lib/canvas/presence";

/**
 * How many circles the strip will show. Past this, the last slot stops being a
 * face and becomes the count of everyone it stands in for.
 */
const MAX_VISIBLE = 5;

/**
 * Who is on this canvas right now, stacked in the top-right corner.
 *
 * Deduped by account rather than by connection: a person with the project open
 * in three tabs is still one person, and showing them three times would make
 * two people look like a crowd. The order is settled by name so every
 * machine — and every re-render — stacks the same faces the same way; a strip
 * that reshuffles when someone joins reads as everyone leaving and coming
 * back.
 *
 * The surface borrows the toolbar's own glass, so the two corners of the
 * canvas read as one system rather than two apps.
 */
export default function PresenceAvatars({ peers }: { peers: CanvasPeer[] }) {
  const byUser = new Map<string, PresenceUser>();

  for (const peer of peers) {
    if (!byUser.has(peer.user.id)) byUser.set(peer.user.id, peer.user);
  }

  const users = [...byUser.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );

  if (users.length === 0) return null;

  const visible = users.length <= MAX_VISIBLE ? users : users.slice(0, MAX_VISIBLE - 1);
  const overflow = users.length - visible.length;

  return (
    <div
      className="flex items-center rounded-full bg-[rgba(22,23,24,0.9)] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
      role="group"
      aria-label={`${users.length} ${users.length === 1 ? "person" : "people"} on this canvas`}
    >
      {/* Overlapped rather than gapped: a run of separate circles is a list,
          and this is meant to read as a group. Each circle keeps a sliver of
          the strip's own fill behind it so the overlap has an edge. */}
      <div className="flex -space-x-2">
        {visible.map((user) => (
          <Avatar key={user.id} user={user} />
        ))}
        {overflow > 0 ? (
          <span
            title={users
              .slice(visible.length)
              .map((user) => user.name)
              .join(", ")}
            className="relative flex size-7 items-center justify-center rounded-full bg-[rgba(218,220,224,0.16)] text-[10px] leading-none font-semibold text-neutral-200 ring-2 ring-[#161718]"
          >
            +{Math.min(overflow, 99)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Avatar({ user }: { user: PresenceUser }) {
  return (
    <span
      title={user.name}
      className="relative flex size-7 items-center justify-center overflow-hidden rounded-full text-[11px] leading-none font-semibold text-white ring-2"
      style={{ backgroundColor: user.color, "--tw-ring-color": user.color } as React.CSSProperties}
    >
      {user.image ? (
        <img
          src={user.image}
          alt={user.name}
          // Google avatar URLs refuse requests that name another site as the
          // referrer, and a broken face is worse than none.
          referrerPolicy="no-referrer"
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        initial(user.name)
      )}
    </span>
  );
}

/** The first grapheme rather than the first byte, so 王雅萱 gets 王 and not a broken glyph. */
function initial(name: string) {
  const first = [...name.trim()][0];

  return first?.toUpperCase() ?? "?";
}
