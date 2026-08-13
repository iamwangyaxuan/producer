import type { AssetKind } from "#/db/schema";

/**
 * What the asset layer accepts, shared by both sides of the upload: the client
 * checks before a request is made so an oversized file fails at the drop
 * instead of after a long transfer, and the server checks again because the
 * client's copy is a courtesy, not a guarantee.
 *
 * Types only are imported from the schema module, so none of drizzle reaches
 * the browser bundle.
 */

/**
 * SVG is deliberately absent from the image list: it can carry script, and
 * these files are served inline from the app's own origin — a stored SVG
 * would be a stored XSS.
 */
export const ALLOWED_MIME: Record<AssetKind, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"],
  voice: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg"],
  music: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg", "audio/flac"],
  video: ["video/mp4", "video/webm", "video/quicktime"]
};

/**
 * Business judgement, not a transport limit: uploads go straight to R2 via
 * presigned URLs, so nothing here is bounded by a Worker request body.
 */
export const MAX_BYTES: Record<AssetKind, number> = {
  image: 25_000_000,
  voice: 50_000_000,
  music: 50_000_000,
  video: 500_000_000
};

/**
 * The kind a dropped file most plausibly is. `voice` is never guessed —
 * nothing in a mime type separates speech from music, so bare audio defaults
 * to the broader label. Returns null for anything the allowlists would refuse
 * anyway.
 */
export function kindFromMime(mimeType: string): AssetKind | null {
  if (ALLOWED_MIME.image.includes(mimeType)) return "image";
  if (ALLOWED_MIME.video.includes(mimeType)) return "video";
  if (ALLOWED_MIME.music.includes(mimeType)) return "music";

  return null;
}
