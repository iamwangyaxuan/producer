import { createFileRoute } from "@tanstack/react-router";

import { headAssetContent, serveAssetContent } from "./content";

/**
 * The same bytes as `/content`, behind a URL that ends in the file's name.
 *
 * It exists so a link reads as what it points at — `…/content/running dog.png`
 * rather than a bare id — and so anything that derives a filename from a URL
 * (a browser's save dialog, a vendor fetching an input) gets a sensible one.
 *
 * The segment is never read. The asset id is the identifier and the served
 * `Content-Disposition` is built from the row, so editing the name in the URL
 * changes how the link looks and nothing else — no lookup to fail, no second
 * name that could disagree with the first.
 */
export const Route = createFileRoute("/api/assets/$assetId/content/$filename")({
  server: {
    handlers: {
      GET: ({ request, params }) => serveAssetContent(request, params.assetId),
      HEAD: ({ request, params }) => headAssetContent(request, params.assetId)
    }
  }
});
