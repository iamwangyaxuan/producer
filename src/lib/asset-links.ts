import { extensionForMime } from "#/lib/asset-constraints";

/**
 * What an asset is called, and where its bytes come from.
 *
 * Both sides of the app agree here: the browser builds URLs from this, and the
 * serving route builds the `Content-Disposition` filename from it, so what a
 * link looks like and what lands on disk are the same name.
 *
 * Kept free of any server import so the browser bundle can have it.
 */

/** The columns a name is built from — any query selecting these will do. */
export interface AssetNameRow {
  kind: string;
  title: string | null;
  filename: string | null;
  prompt: string | null;
  mimeType: string | null;
}

/**
 * Path separators, the characters Windows reserves in filenames, and the
 * control-character category. Spaces and dashes are deliberately absent — both
 * are ordinary in a title, and the URL encodes whatever needs encoding.
 */
const UNSAFE_IN_NAME = /[\\/:*?"<>|]|\p{Cc}/gu;

/**
 * The display name for an asset, falling back through everything that could
 * stand in for one.
 *
 * `title` is what the app writes deliberately — an upload's own name, or the
 * phrase a model wrote for a generation. The rest of the chain is for the
 * generation whose naming call failed, which is still a perfectly good asset
 * and must still be called something.
 */
export function assetTitle(asset: AssetNameRow): string {
  const candidate = asset.title ?? stripExtension(asset.filename) ?? asset.prompt ?? asset.kind;

  // Collapsed to one line and bounded, because this ends up in a URL segment
  // and a filesystem name — neither tolerates a newline, and both have length
  // limits well below what a prompt can be.
  const clean = candidate.replace(UNSAFE_IN_NAME, " ").replace(/\s+/gu, " ").trim().slice(0, 60);

  return clean || asset.kind;
}

/** `photo.png` → `photo`; null in, null out. */
function stripExtension(filename: string | null) {
  if (!filename) return null;

  return filename.replace(/\.[^./\\]+$/u, "") || filename;
}

/**
 * The full filename: the title plus the extension its stored type implies.
 *
 * The extension comes from the mime rather than from whatever the file was
 * called on the way in, so it always describes the bytes that will actually be
 * served.
 */
export function assetFileName(asset: AssetNameRow): string {
  return `${assetTitle(asset)}${extensionForMime(asset.mimeType)}`;
}

/**
 * Where the browser fetches an asset's bytes from.
 *
 * A path on this app rather than a link to the bucket, and that is the whole
 * point of it. Three things follow from the URL being ours and being stable:
 *
 *   - authorization runs on every request, so losing access to an organization
 *     stops the pictures immediately rather than whenever a signature lapses;
 *   - the URL for an asset never changes, so the browser's cache is worth
 *     something and a re-render does not re-download a video;
 *   - it derives from an id, so nothing has to be fetched, stored or refreshed
 *     to know it — which is what lets a canvas node hold only the id.
 *
 * The trailing name segment is decoration the server ignores: it is there so a
 * link reads as `…/content/running dog.png` rather than ending in an opaque
 * id, and so a browser that saves the target has a name to use. Downloads skip
 * it and address the bare id — the `Content-Disposition` the route builds from
 * the row is what names that file, so a second name in the path would only be
 * something to disagree with it.
 *
 * The presigned R2 links live at the other end of the asset layer, in
 * `server/asset-url.ts`, and are for the one consumer that cannot use this:
 * a model provider, which fetches with no session at all.
 */
export function assetContentUrl(
  assetId: string,
  options?: { filename?: string; download?: boolean }
) {
  const base = `/api/assets/${assetId}/content`;
  // Encoded as one segment: a title can hold spaces, and `#`/`?` would
  // otherwise cut the path short.
  const named = options?.filename ? `${base}/${encodeURIComponent(options.filename)}` : base;

  return options?.download ? `${named}?download=1` : named;
}
