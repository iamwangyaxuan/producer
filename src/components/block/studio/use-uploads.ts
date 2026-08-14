import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import type { GenerationNodeData } from "#/components/block/studio/generation-node";
import type { AssetKind } from "#/db/schema";
import { assetTitle } from "#/lib/asset-links";
import { projectAssetsScope } from "#/lib/assets";
import { HttpError, retriableFetchFailure, withRetry } from "#/lib/retry";

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
  /** The exact Content-Type the presigned URL was signed for. */
  contentType: string;
}

/** What a retry needs to run the same upload again — the file above all. */
interface UploadSource {
  file: File;
  projectId: string;
  kind: AssetKind;
}

async function expectJson<T>(response: Response, step: string): Promise<T> {
  // Thrown with the status attached, because that is what decides whether the
  // step is worth repeating — a 413 will be a 413 however many times it is
  // asked, while a 503 is a different answer each time.
  if (!response.ok) throw new HttpError(response.status, `${step} answered ${response.status}`);

  return response.json() as Promise<T>;
}

export function useUploads() {
  /** One per upload still in flight, so deleting a node can call off its work. */
  const inFlight = useRef(new Map<string, AbortController>());

  /**
   * The file behind each node, kept until the upload lands or the node goes.
   *
   * A retry cannot re-read what the person dropped — the drop event is long
   * over — so the only way to offer one is to still be holding the `File`. It
   * costs nothing to hold: a `File` is a handle to bytes on disk, not the
   * bytes. What it cannot survive is the tab, which is why the canvas asks
   * `canRetry` before offering the button rather than after.
   */
  const sources = useRef(new Map<string, UploadSource>());

  const queryClient = useQueryClient();

  async function run(
    id: string,
    { file, projectId, kind }: UploadSource,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    const controller = new AbortController();
    inFlight.current.set(id, controller);

    // A big file on a slow line takes longer than the sweep's patience, so
    // the node's age is renewed while the transfer is genuinely alive.
    const heartbeat = setInterval(() => {
      patch(id, { requestedAt: Date.now() });
    }, HEARTBEAT_MS);

    const retry = { signal: controller.signal };

    try {
      // Three steps: describe the file and get a row plus a presigned URL,
      // PUT the bytes straight to the bucket, then tell the app they arrived
      // so the row can be measured and marked ready. Only the middle step
      // carries the payload, and it never touches the Worker.
      //
      // Repeating this first step can leave a pending row nobody adopts — the
      // answer may have been lost on the way back rather than never written —
      // but that row holds no bytes and the sweep collects it, which is a
      // cheaper failure than telling someone their upload died on a hiccup.
      const created = await withRetry(
        () =>
          fetch("/api/assets", {
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
          }).then((response) => expectJson<CreatedAsset>(response, "create")),
        retriableFetchFailure,
        retry
      );

      const { assetId, uploadUrl, contentType } = created;

      // Bound to the node before a single byte moves, for the reason
      // `useGenerations` does the same: from here on the node and the row
      // name each other, so deleting the node mid-transfer deletes the asset
      // by id instead of stranding a pending row nothing points at.
      patch(id, { assetId });

      // The one step that is perfectly safe to repeat, and the one that fails
      // most: same URL, same key, same bytes, and the row is not touched
      // until `complete` — so a second PUT is indistinguishable from the
      // first. The presigned URL outlives every attempt (minutes against
      // seconds), so no re-signing is needed in between.
      await withRetry(
        async () => {
          const put = await fetch(uploadUrl, {
            method: "PUT",
            body: file,
            // The server's spelling, not `file.type`. Both name the same type,
            // but only one of them is inside the signature — and sending the
            // canonical form is also what keeps the object's stored
            // `Content-Type` equal to the row's, rather than whatever
            // parameters the browser appended.
            headers: { "Content-Type": contentType },
            signal: controller.signal
          });

          if (!put.ok) throw new HttpError(put.status, `upload answered ${put.status}`);
        },
        retriableFetchFailure,
        retry
      );

      await withRetry(
        async () => {
          const completed = await fetch(`/api/assets/${assetId}/complete`, {
            method: "POST",
            signal: controller.signal
          });

          // A 409 lands here and is deliberately not retried: it means the row
          // is no longer waiting for an upload, which a repeat cannot change.
          if (!completed.ok) {
            throw new HttpError(completed.status, `complete answered ${completed.status}`);
          }
        },
        retriableFetchFailure,
        retry
      );

      // No URL is written into the document — the node keeps the asset id it
      // was bound to before the transfer, and derives the link from it. What
      // does go in is what a URL cannot be rebuilt without: the canonical type
      // (a video player routes by it) and the file's name.
      patch(id, {
        mimeType: contentType,
        // The same name the server derived for the row, computed from the
        // same function so the node and the database agree.
        title: assetTitle({
          kind,
          title: null,
          filename: file.name,
          prompt: null,
          mimeType: contentType
        }),
        status: "ready"
      });

      // Landed, so nothing is owed a second attempt and the file can go.
      sources.current.delete(id);

      await queryClient.invalidateQueries({ queryKey: projectAssetsScope(projectId) });
    } catch {
      // A cancelled upload belongs to a node that is already gone; marking it
      // failed would be describing something nobody can see. The file is kept
      // for anything else, because that is the case a person may want to try
      // again.
      if (!controller.signal.aborted) patch(id, { status: "failed" });
    } finally {
      clearInterval(heartbeat);
      inFlight.current.delete(id);
    }
  }

  async function start(
    id: string,
    projectId: string,
    file: File,
    kind: AssetKind,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    const source = { file, projectId, kind };

    sources.current.set(id, source);

    return run(id, source, patch);
  }

  /**
   * A second attempt at an upload this tab still holds the file for. A whole
   * new row and object key rather than a resumption: the previous attempt's
   * row may be pending with a half-written object behind it, and the sweep
   * collects that far more safely than this could reason about it.
   */
  async function retry(id: string, patch: (id: string, data: Partial<GenerationNodeData>) => void) {
    const source = sources.current.get(id);

    if (!source || inFlight.current.has(id)) return;

    // Cleared alongside the status so the node stops offering a download for
    // an asset the retry is about to replace.
    patch(id, { status: "pending", requestedAt: Date.now(), assetId: undefined });

    return run(id, source, patch);
  }

  /** Whether a failed node can be tried again — i.e. whether this tab still has the file. */
  function canRetry(id: string) {
    return sources.current.has(id);
  }

  function cancel(ids: readonly string[]) {
    for (const id of ids) {
      inFlight.current.get(id)?.abort();
      inFlight.current.delete(id);
      sources.current.delete(id);
    }
  }

  /** Whether this client is the one still moving the file. */
  function owns(id: string) {
    return inFlight.current.has(id);
  }

  return { start, retry, canRetry, cancel, owns };
}
