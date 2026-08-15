import type { CanvasPeer } from "#/components/block/studio/use-canvas-collab";
import Avatar, { AvatarGroup } from "#/components/ui/avatar";
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

  return (
    <div
      className="flex items-center rounded-full bg-[rgba(22,23,24,0.9)] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
      role="group"
      aria-label={`${users.length} ${users.length === 1 ? "person" : "people"} on this canvas`}
    >
      <AvatarGroup
        max={MAX_VISIBLE}
        // The chip is told who it stands for, since the faces it replaced were
        // each carrying their own name.
        overflowTitle={users
          .slice(MAX_VISIBLE - 1)
          .map((user) => user.name)
          .join(", ")}
      >
        {users.map((user) => (
          <Avatar key={user.id} name={user.name} src={user.image} color={user.color} />
        ))}
      </AvatarGroup>
    </div>
  );
}
