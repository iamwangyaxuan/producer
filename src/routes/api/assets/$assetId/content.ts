import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

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
  return new Headers({
    // The DB row is canonical — never R2 metadata, never sniffing, and
    // `nosniff` because the type was an upload-time claim.
    "Content-Type": asset.mimeType ?? "application/octet-stream",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "Cache-Control": CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline"
  });
}

/**
 * `?download=1` turns the inline default into an attachment named after the
 * uploaded filename — which lives in a DB column, never in the object key, so
 * it is encoded here rather than trusted anywhere else.
 */
function withDisposition(headers: Headers, request: Request, asset: AssetRow) {
  const wantsDownload = new URL(request.url).searchParams.has("download");

  if (!wantsDownload) return headers;

  const name = asset.filename ?? `${asset.kind}-${asset.id}`;
  const ascii = name.replace(/[^\x20-\x7e]/gu, "_").replaceAll('"', "'");

  headers.set(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
  );

  return headers;
}

export const Route = createFileRoute("/api/assets/$assetId/content")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const access = await requireAssetAccess(request.headers, params.assetId);

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
          object = await env.MEDIA.get(asset.objectKey, {
            range: request.headers.has("range") ? request.headers : undefined,
            onlyIf: request.headers
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

        const headers = withDisposition(baseHeaders(asset, object.httpEtag), request, asset);

        // `onlyIf` matched: R2 answers with metadata but no body, which is
        // exactly a 304.
        if (!("body" in object)) {
          return new Response(null, { status: 304, headers });
        }

        // Judged by what the client asked, not by what the result object
        // carries: this runtime populates `object.range` with a full-object
        // span even on a plain read, and a 206 nobody asked for confuses
        // caches and media elements alike.
        const served =
          request.headers.has("range") && object.range
            ? resolveRange(object.range, object.size)
            : null;

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
      },

      // Some players probe with HEAD before committing to a stream; answering
      // it honestly costs one metadata read.
      HEAD: async ({ request, params }) => {
        const access = await requireAssetAccess(request.headers, params.assetId);

        if (!access || access.asset.status !== "ready") {
          return new Response(null, { status: 404 });
        }

        const object = await env.MEDIA.head(access.asset.objectKey);

        if (!object) return new Response(null, { status: 404 });

        const headers = baseHeaders(access.asset, object.httpEtag);
        headers.set("Content-Length", String(object.size));

        return new Response(null, { status: 200, headers });
      }
    }
  }
});
