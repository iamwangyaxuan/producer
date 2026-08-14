import type { AssetKind } from "#/db/schema";
import { servableMime } from "#/lib/asset-constraints";
import { presignDownloadUrl } from "#/server/r2-presign";

/**
 * The asset layer's one exit for bytes leaving this app.
 *
 * Everything inside the product reads media through `/api/assets/:id/content`
 * — a stable path, authorized per request. This is the other case, and it has
 * exactly one caller: a model provider fetching the files a prompt referred to.
 * It runs on someone else's infrastructure with none of this app's cookies, so
 * a link is the only thing it can be handed, and that link has to work on its
 * own.
 *
 * Which makes what comes out of here a bearer credential, and it is treated
 * like one: minted per request, never stored, never returned to a browser, and
 * expiring in minutes. Authorization happens once — here, at minting time — so
 * every caller must have already established that the bytes may leave.
 */

/** The columns a link is built from — any query selecting these will do. */
export interface AssetUrlRow {
  id: string;
  kind: AssetKind;
  mimeType: string | null;
  filename: string | null;
  objectKey: string;
}

/**
 * `attachment` with the name the row records, encoded both ways RFC 6266 asks
 * for: a plain `filename` stripped to ASCII for parsers that read only that,
 * and `filename*` carrying the real one. Quotes are folded rather than escaped
 * so a crafted filename cannot close the quoted string early and inject
 * parameters of its own.
 */
function attachment(asset: AssetUrlRow) {
  const name = asset.filename ?? `${asset.kind}-${asset.id}`;
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replaceAll('"', "'");

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * A short-lived link a third party can fetch this asset's bytes from.
 *
 * The response headers are decided here rather than left to whatever
 * `Content-Type` was stored on the object, because that value is a claim made
 * by whoever produced the file — the same claim the serving route refuses to
 * trust. A type outside the allowlist goes out as an opaque download, which is
 * the same verdict the Worker would have reached.
 */
export function assetDownloadUrl(asset: AssetUrlRow) {
  const servable = servableMime(asset.kind, asset.mimeType);

  return presignDownloadUrl({
    objectKey: asset.objectKey,
    contentType: servable ?? "application/octet-stream",
    contentDisposition: servable ? "inline" : attachment(asset)
  });
}
