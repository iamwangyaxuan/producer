/**
 * What one connected person looks like to everyone else on the canvas.
 *
 * Shared through the awareness protocol rather than the document: presence is
 * true only while the connection lives, and awareness is the half of the sync
 * that is dropped — not merged, not persisted — the moment the socket closes,
 * which is exactly the lifetime a cursor has.
 */

export interface PresenceUser {
  /** The account id, stable across tabs — the avatar strip dedupes on it. */
  id: string;
  name: string;
  image: string | null;
  /** Assigned from the palette by account id, so every tab agrees on it. */
  color: string;
}

export interface PresenceState {
  user: PresenceUser;
  /** Flow coordinates, so every zoom level agrees; null while the pointer is off the canvas. */
  cursor: { x: number; y: number } | null;
}

/**
 * Colours cursors and avatar rings are drawn in, picked to stay apart from the
 * canvas's own vocabulary: no blue — the alignment guides own it — and nothing
 * so dark it vanishes against the near-black board every one of these sits on.
 */
const PALETTE = [
  "#f97316", // orange
  "#22c55e", // green
  "#e879f9", // fuchsia
  "#eab308", // yellow
  "#2dd4bf", // teal
  "#f43f5e", // rose
  "#a3e635", // lime
  "#c084fc" // purple
] as const;

/**
 * The same account lands on the same colour on every machine without anything
 * being negotiated: the id is hashed, not assigned. Two people can collide on
 * a colour — with eight entries that takes nine of them — and a collision
 * costs a glance at the name label, which the cursor carries anyway.
 */
export function presenceColor(userId: string): string {
  let hash = 0;

  for (const char of userId) {
    hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0;
  }

  return PALETTE[Math.abs(hash) % PALETTE.length];
}
