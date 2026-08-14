import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { servableMime } from "#/lib/asset-constraints";
import { assetFileName } from "#/lib/asset-links";
import { requireAssetAccess } from "#/server/asset-access";
import type { AssetRow } from "#/server/asset-access";

/**
 * The bytes behind an asset, for the media tags on the canvas. Same origin as
 * the app, so the session cookie rides along on every request a media element
 * makes — including the Range follow-ups a scrubbing video player sends — and
 * authorization runs on each one.
 */

/**
 * Bounded rather than immutable, despite immutable keys: the browser HTTP
 * cache is not keyed by cookie, so on a shared machine a signed-out or
 * switched user could be served another account's cached media for as long as
 * the response stays fresh. An hour absorbs canvas re-render churn; past it,
 * revalidation is a cheap 304 that still runs the auth check.
 */
const CACHE_CONTROL = "private, max-age=3600";

/**
 * The conditions R2 may answer for us: the two that ask "has this changed,
 * and may I keep what I have". Their failure mode is a 304, which is what R2
 * expresses by returning a bodiless object.
 */
function revalidationConditions(headers: Headers) {
  const delegated = new Headers();
  const ifNoneMatch = headers.get("if-none-match");
  const ifModifiedSince = headers.get("if-modified-since");

  if (ifNoneMatch) delegated.set("if-none-match", ifNoneMatch);
  if (ifModifiedSince) delegated.set("if-modified-since", ifModifiedSince);

  return delegated;
}

/**
 * The conditions whose failure owes a 412 — "only act if the thing is still
 * as I last saw it". Evaluated here because R2 reports every failed condition
 * identically, and answering an unmet `If-Match` with a 304 would tell a
 * client its stale copy is current.
 *
 * ETag comparison is strong: these preconditions are about acting on an exact
 * representation, and a weak match is not a guarantee of one.
 */
function failedPrecondition(headers: Headers, object: R2Object) {
  const ifMatch = headers.get("if-match");

  if (ifMatch) {
    const tags = ifMatch.split(",").map((tag) => tag.trim());

    if (!tags.includes("*") && !tags.includes(object.httpEtag)) return true;
  }

  const ifUnmodifiedSince = headers.get("if-unmodified-since");

  if (ifUnmodifiedSince) {
    const limit = Date.parse(ifUnmodifiedSince);

    // An unparseable date is no condition at all, per RFC 9110. The second of
    // slack absorbs the sub-second precision HTTP dates do not carry.
    if (!Number.isNaN(limit) && object.uploaded.getTime() > limit + 999) return true;
  }

  return false;
}

/**
 * What was actually served, from R2's three ways of answering a range ask —
 * or null when the "range" is not one. workerd materializes `object.range`
 * with every key present and undefined, so `"suffix" in range` alone lies;
 * only actual numbers count.
 */
function resolveRange(range: R2Range, size: number): { offset: number; length: number } | null {
  const suffix = "suffix" in range ? range.suffix : undefined;

  if (typeof suffix === "number") {
    const length = Math.min(suffix, size);

    return { offset: size - length, length };
  }

  const offset = "offset" in range && typeof range.offset === "number" ? range.offset : undefined;
  const length = "length" in range && typeof range.length === "number" ? range.length : undefined;

  if (offset === undefined && length === undefined) return null;

  const from = offset ?? 0;

  return { offset: from, length: length ?? size - from };
}

function baseHeaders(asset: AssetRow, etag: string) {
  // The same verdict the presigned path pins as `response-content-type`, from
  // the same function, so the two ways out of the asset layer cannot come to
  // different conclusions about what a file may be served as.
  const type = servableMime(asset.kind, asset.mimeType);

  return new Headers({
    // The DB row is canonical — never R2 metadata, never sniffing, and
    // `nosniff` because the type was an upload-time claim.
    "Content-Type": type ?? "application/octet-stream",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "Cache-Control": CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": type ? "inline" : "attachment"
  });
}

/**
 * `?download=1` turns the inline default into an attachment named after the
 * uploaded filename — which lives in a DB column, never in the object key, so
 * it is encoded here rather than trusted anywhere else.
 */
function withDisposition(headers: Headers, request: Request, asset: AssetRow) {
  const wantsDownload = new URL(request.url).searchParams.has("download");

  // A type this app will not render inline is already an attachment; naming
  // the file is still worth doing.
  if (!wantsDownload && headers.get("Content-Disposition") === "inline") return headers;

  // The row's own name, built the same way every other surface builds it —
  // so what the URL says the file is called and what lands on disk agree.
  const name = assetFileName(asset);
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replaceAll('"', "'");

  headers.set(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );

  return headers;
}

/**
 * Both routes run this: `/content` and `/content/<name>.<ext>`.
 *
 * The name segment is decoration — it makes a link read as the file it points
 * at, and gives a browser something to save it as. It is deliberately not
 * consulted here: the asset id is the identifier, and the served filename is
 * built from the row (see `withDisposition`), so a hand-edited name in the URL
 * changes what the link looks like and nothing else.
 */
export async function serveAssetContent(request: Request, assetId: string) {
  const access = await requireAssetAccess(request.headers, assetId);

  // Only ready rows serve: a pending object may be half-written, and a
  // failed one has nothing worth showing. Both answer like they do not
  // exist, same as another tenant's asset.
  if (!access || access.asset.status !== "ready") {
    return new Response("Not found", { status: 404 });
  }

  const { asset } = access;

  let object: R2Object | R2ObjectBody | null;
  try {
    // R2 parses the Range and conditional headers itself; an
    // unsatisfiable or multipart range is the one case it throws for.
    // The header set is only offered as a range when it actually holds
    // one — offered unconditionally, a plain GET comes back wearing a
    // vacuous range and would be served as a 206.
    //
    // Only the cache-revalidation conditions are delegated. R2 answers
    // any failed condition the same way — metadata, no body — which
    // reads as a 304, but a failed `If-Match` owes a 412; those are
    // evaluated below instead.
    object = await env.MEDIA.get(asset.objectKey, {
      range: request.headers.has("range") ? request.headers : undefined,
      onlyIf: revalidationConditions(request.headers)
    });
  } catch {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${asset.sizeBytes ?? 0}` }
    });
  }

  // A ready row whose object is gone is a broken invariant, not a user
  // mistake — worth a log line the day it happens.
  if (!object) {
    console.error(`asset ${asset.id} is ready but ${asset.objectKey} is missing from R2`);

    return new Response("Not found", { status: 404 });
  }

  // The bytes are only this asset's if they are the ones it was
  // measured with. An upload's presigned URL stays usable after
  // completion, so a moved ETag means something replaced the object
  // behind a row that had already been checked — served, it would hand
  // teammates content nothing ever validated.
  if (asset.etag && object.etag !== asset.etag) {
    console.error(`asset ${asset.id} object ${asset.objectKey} changed under a ready row`);

    return new Response("Not found", { status: 404 });
  }

  const headers = withDisposition(baseHeaders(asset, object.httpEtag), request, asset);

  const precondition = failedPrecondition(request.headers, object);

  if (precondition) return new Response(null, { status: 412, headers });

  // A delegated condition matched: R2 answers with metadata but no
  // body, which is exactly a 304.
  if (!("body" in object)) {
    return new Response(null, { status: 304, headers });
  }

  // Judged by what the client asked, not by what the result object
  // carries: this runtime populates `object.range` with a full-object
  // span even on a plain read, and a 206 nobody asked for confuses
  // caches and media elements alike.
  const served =
    request.headers.has("range") && object.range ? resolveRange(object.range, object.size) : null;

  if (served) {
    headers.set(
      "Content-Range",
      `bytes ${served.offset}-${served.offset + served.length - 1}/${object.size}`
    );
    headers.set("Content-Length", String(served.length));

    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));

  return new Response(object.body, { status: 200, headers });
}

/**
 * Some players probe with HEAD before committing to a stream; answering it
 * honestly costs one metadata read.
 */
export async function headAssetContent(request: Request, assetId: string) {
  const access = await requireAssetAccess(request.headers, assetId);

  if (!access || access.asset.status !== "ready") {
    return new Response(null, { status: 404 });
  }

  const object = await env.MEDIA.head(access.asset.objectKey);

  if (!object) return new Response(null, { status: 404 });

  // The same refusal the GET gives a replaced object, or a player's
  // probe would succeed against bytes the stream request then 404s.
  if (access.asset.etag && object.etag !== access.asset.etag) {
    console.error(
      `asset ${access.asset.id} object ${access.asset.objectKey} changed under a ready row`
    );

    return new Response(null, { status: 404 });
  }

  const headers = baseHeaders(access.asset, object.httpEtag);
  headers.set("Content-Length", String(object.size));

  return new Response(null, { status: 200, headers });
}

export const Route = createFileRoute("/api/assets/$assetId/content")({
  server: {
    handlers: {
      GET: ({ request, params }) => serveAssetContent(request, params.assetId),
      HEAD: ({ request, params }) => headAssetContent(request, params.assetId)
    }
  }
});
