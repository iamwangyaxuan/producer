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
 * these files were served inline from the app's own origin — a stored SVG
 * would have been a stored XSS. Bytes now leave through presigned R2 URLs on a
 * different host, which declaws that specific attack, but the list stays as it
 * is: it is also what decides whether a type renders at all, and widening it
 * for a format nothing displays would buy nothing.
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
 * The extension to put on a file of each stored type.
 *
 * Derived from the mime rather than kept from the upload, so the extension
 * always agrees with what the bytes will actually be served as — a file
 * uploaded as `photo.jpeg` and a generation that came back `image/jpeg` get
 * the same suffix. One entry per allowlisted type; anything else has no
 * extension to offer, which the callers handle.
 */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/webm": ".weba",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov"
};

/** The extension for a stored type, or "" when the type is not one we name. */
export function extensionForMime(mimeType: string | null): string {
  if (!mimeType) return "";

  return MIME_EXTENSIONS[normalizeMime(mimeType)] ?? "";
}

/**
 * Spellings that mean an allowlisted type without being one. `image/jpg` has
 * never been registered, but tools emit it anyway.
 */
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg"
};

/**
 * The spelling the allowlists speak: parameters dropped, lowercased, aliases
 * resolved. MIME types are case-insensitive per RFC 2045 and providers and
 * non-browser clients do use the room that gives them — `image/JPEG` must
 * match the allowlist, but only the canonical spelling may be *stored*, so
 * every consumer (the allowlist checks, the serving route's inline decision)
 * compares one vocabulary.
 */
export function normalizeMime(mimeType: string): string {
  const bare = mimeType.split(";")[0].trim().toLowerCase();

  return MIME_ALIASES[bare] ?? bare;
}

/**
 * The type a stored asset may be *served* as, or null when it is not one this
 * app accepts for that kind.
 *
 * Judged at the sink rather than trusted from the row, because a row can hold a
 * type the allowlist no longer accepts in two ways: a generation records
 * whatever the provider's `Content-Type` said, and the lists themselves may
 * tighten. A stranger is handed back as an opaque download instead of being
 * rendered, which is the difference between a file and something the browser
 * will execute.
 *
 * Both ways out of the asset layer run on this: the serving route sets it as a
 * header, and the presigned URL pins it as `response-content-type` so R2 says
 * the same thing this app would have.
 */
export function servableMime(kind: AssetKind, mimeType: string | null): string | null {
  if (!mimeType) return null;

  const declared = normalizeMime(mimeType);

  return ALLOWED_MIME[kind].includes(declared) ? declared : null;
}

/**
 * The kind a dropped file most plausibly is. `voice` is never guessed —
 * nothing in a mime type separates speech from music, so bare audio defaults
 * to the broader label. Returns null for anything the allowlists would refuse
 * anyway.
 */
export function kindFromMime(mimeType: string): AssetKind | null {
  const declared = normalizeMime(mimeType);

  if (ALLOWED_MIME.image.includes(declared)) return "image";
  if (ALLOWED_MIME.video.includes(declared)) return "video";
  if (ALLOWED_MIME.music.includes(declared)) return "music";

  return null;
}
