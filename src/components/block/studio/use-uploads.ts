import { useRef } from "react";

import type { GenerationNodeData } from "#/components/block/studio/generation-node";
import type { AssetKind } from "#/db/schema";

/**
 * Uploads still in flight, shaped like `useGenerations` so the canvas treats
 * both kinds of pending node the same way: deleting a node calls off its
 * work, and the orphan sweep leaves alone whatever this tab still owns.
 */

/**
 * Often enough that the collaboration layer's two-minute orphan sweep — which
 * other tabs run too, and which only excuses work *they* own — never sees a
 * live upload as abandoned, and rarely enough that the document is not being
 * churned for its own sake.
 */
const HEARTBEAT_MS = 60_000;

interface CreatedAsset {
  assetId: string;
  uploadUrl: string;
}

interface CompletedAsset {
  assetId: string;
  url: string;
}

async function expectJson<T>(response: Response, step: string): Promise<T> {
  if (!response.ok) throw new Error(`${step} answered ${response.status}`);

  return response.json() as Promise<T>;
}

export function useUploads() {
  /** One per upload still in flight, so deleting a node can call off its work. */
  const inFlight = useRef(new Map<string, AbortController>());

  async function start(
    id: string,
    projectId: string,
    file: File,
    kind: AssetKind,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    const controller = new AbortController();
    inFlight.current.set(id, controller);

    // A big file on a slow line takes longer than the sweep's patience, so
    // the node's age is renewed while the transfer is genuinely alive.
    const heartbeat = setInterval(() => {
      patch(id, { requestedAt: Date.now() });
    }, HEARTBEAT_MS);

    try {
      // Three steps: describe the file and get a row plus a presigned URL,
      // PUT the bytes straight to the bucket, then tell the app they arrived
      // so the row can be measured and marked ready. Only the middle step
      // carries the payload, and it never touches the Worker.
      const created = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          kind,
          mimeType: file.type,
          sizeBytes: file.size,
          filename: file.name
        }),
        signal: controller.signal
      });
      const { assetId, uploadUrl } = await expectJson<CreatedAsset>(created, "create");

      // Bound to the node before a single byte moves, for the reason
      // `useGenerations` does the same: from here on the node and the row
      // name each other, so deleting the node mid-transfer deletes the asset
      // by id instead of stranding a pending row nothing points at.
      patch(id, { assetId });

      const put = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        // Part of the presigned signature — R2 refuses the PUT if it drifts
        // from what the row declared.
        headers: { "Content-Type": file.type },
        signal: controller.signal
      });

      if (!put.ok) throw new Error(`upload answered ${put.status}`);

      const completed = await fetch(`/api/assets/${assetId}/complete`, {
        method: "POST",
        signal: controller.signal
      });
      const { url } = await expectJson<CompletedAsset>(completed, "complete");

      patch(id, { src: url, mimeType: file.type, status: "ready" });
    } catch {
      // A cancelled upload belongs to a node that is already gone; marking it
      // failed would be describing something nobody can see.
      if (!controller.signal.aborted) patch(id, { status: "failed" });
    } finally {
      clearInterval(heartbeat);
      inFlight.current.delete(id);
    }
  }

  function cancel(ids: readonly string[]) {
    for (const id of ids) {
      inFlight.current.get(id)?.abort();
      inFlight.current.delete(id);
    }
  }

  /** Whether this client is the one still moving the file. */
  function owns(id: string) {
    return inFlight.current.has(id);
  }

  return { start, cancel, owns };
}
