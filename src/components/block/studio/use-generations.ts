import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import type { ComposerSubmission } from "#/components/block/studio/ai-composer";
import type { GenerationNodeData } from "#/components/block/studio/generation-node";
import { projectAssetsScope } from "#/lib/assets";
import { retryGeneration, runGeneration, startGeneration } from "#/lib/generate-asset";

/**
 * The requests still in flight, kept apart from the canvas so deleting a node —
 * locally or from another machine — can call off its work without the canvas
 * knowing how the work is done.
 */

/**
 * The same renewal contract uploads keep: the collaboration layer's orphan
 * sweep — which other tabs run too, and which only excuses work *they* own —
 * counts from `requestedAt`, and a real model happily outlives its two-minute
 * patience. Renewing while the request is genuinely in flight is what keeps a
 * slow generation from being declared dead by a tab that cannot see it.
 */
const HEARTBEAT_MS = 60_000;

export function useGenerations() {
  /** One per request still in flight, so deleting a node can call off its work. */
  const inFlight = useRef(new Map<string, AbortController>());

  /**
   * What each node asked for, kept for the one retry the server cannot serve
   * itself: if `startGeneration` never answered there is no row to copy the
   * request off, and the canvas document does not hold enough to rebuild it —
   * `resolution`, `duration` and the attachment list were never written into
   * a node. Dropped as soon as an asset row exists, because from that moment
   * the row is the better record of what was asked.
   */
  const submissions = useRef(
    new Map<string, { projectId: string; submission: ComposerSubmission }>()
  );

  const queryClient = useQueryClient();

  /**
   * The shared body of both paths. They differ only in how the asset row comes
   * to exist — created, or copied off a failed one — and everything after that
   * is the same: bind the id to the node, run the slow half, record what came
   * back.
   */
  async function work(
    id: string,
    projectId: string,
    claim: (signal: AbortSignal) => Promise<string>,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    const controller = new AbortController();
    inFlight.current.set(id, controller);

    const heartbeat = setInterval(() => {
      patch(id, { requestedAt: Date.now() });
    }, HEARTBEAT_MS);

    try {
      // The seam is the point: the claim only creates the asset record and
      // answers with its id, which lands on the node *before* any model runs.
      // From that moment the node and the row name each other — deleting the
      // node mid-generation deletes the asset by id, and the server's
      // completion bind notices and discards the bytes instead of leaving an
      // unowned file behind.
      const assetId = await claim(controller.signal);

      patch(id, { assetId });

      // The slow half: provider, R2, and the guarded bind of bytes to row.
      // Everything the model needs was recorded by the claim, so this carries
      // nothing but the id.
      //
      // Never retried from here, whatever it failed with. The claim inside it
      // is spent on the first attempt — `runGeneration` moves the row off
      // "never claimed" before calling the provider — so a second call can
      // only be refused. A retry has to start from a new row, which is what
      // `retry` below is for.
      const { mimeType, title } = await runGeneration({
        data: { assetId },
        signal: controller.signal
      });

      // No URL goes into the document. What the node keeps is the asset id it
      // was given before the model ran; the link is minted by the assets query,
      // which this invalidation is what wakes up — and which every other tab in
      // the room does for itself when its own copy of the row list goes stale.
      patch(id, { mimeType, title: title ?? undefined, status: "ready" });

      submissions.current.delete(id);

      await queryClient.invalidateQueries({ queryKey: projectAssetsScope(projectId) });
    } catch {
      // A cancelled request belongs to a node that is already gone; marking it
      // failed would be describing something nobody can see.
      if (!controller.signal.aborted) patch(id, { status: "failed" });
    } finally {
      clearInterval(heartbeat);
      inFlight.current.delete(id);

      // Both outcomes move the balance: a generation debits it, and one that
      // failed debits and then refunds. Invalidating on either — and on a
      // cancel, which costs nothing but is not worth a third branch to
      // exclude — is what keeps the price beside the send button honest about
      // what is left to spend it from.
      await queryClient.invalidateQueries({ queryKey: ["credits"] });
    }
  }

  async function start(
    id: string,
    projectId: string,
    submission: ComposerSubmission,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    submissions.current.set(id, { projectId, submission });

    return work(
      id,
      projectId,
      async (signal) => {
        const { assetId } = await startGeneration({
          data: {
            projectId,
            modality: submission.modality,
            prompt: submission.text,
            model: submission.model,
            resolution: submission.resolution,
            aspectRatio: submission.aspectRatio,
            duration: submission.duration,
            referenceAssetIds: submission.referenceAssetIds ?? []
          },
          signal
        });

        return assetId;
      },
      patch
    );
  }

  /**
   * A second attempt at a node whose generation failed.
   *
   * Which of the two claims runs depends on how far the first attempt got. If
   * a row exists, the server copies the request off it — that row holds the
   * resolution, duration and reference list the canvas never stored, so the
   * retry is the same request rather than a similar one. If the very first
   * call never answered there is no row, and the submission this tab kept is
   * the only complete record left.
   */
  async function retry(
    id: string,
    projectId: string,
    data: GenerationNodeData,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    if (inFlight.current.has(id)) return;

    const failedAssetId = data.assetId;
    const kept = submissions.current.get(id);

    if (!failedAssetId && !kept) return;

    // Back to pending before anything is awaited, so the node stops offering
    // a retry it is already running — and the sweep's clock restarts with it.
    patch(id, { status: "pending", requestedAt: Date.now() });

    return work(
      id,
      projectId,
      async (signal) => {
        if (failedAssetId) {
          const { assetId } = await retryGeneration({ data: { assetId: failedAssetId }, signal });

          return assetId;
        }

        // Unreachable past the guard above, and left as a throw rather than an
        // assertion so a future caller that skips the guard fails the node
        // instead of sending a request with half its fields missing.
        if (!kept) throw new Error("Nothing to retry.");

        const { assetId } = await startGeneration({
          data: {
            projectId,
            modality: kept.submission.modality,
            prompt: kept.submission.text,
            model: kept.submission.model,
            resolution: kept.submission.resolution,
            aspectRatio: kept.submission.aspectRatio,
            duration: kept.submission.duration,
            referenceAssetIds: kept.submission.referenceAssetIds ?? []
          },
          signal
        });

        return assetId;
      },
      patch
    );
  }

  /**
   * Whether a failed node has anything to try again with — an asset row the
   * server can copy, or a submission this tab still remembers.
   */
  function canRetry(data: GenerationNodeData, id: string) {
    return Boolean(data.assetId) || submissions.current.has(id);
  }

  function cancel(ids: readonly string[]) {
    for (const id of ids) {
      inFlight.current.get(id)?.abort();
      inFlight.current.delete(id);
      submissions.current.delete(id);
    }
  }

  /** Whether this client is the one still working on the node. */
  function owns(id: string) {
    return inFlight.current.has(id);
  }

  return { start, retry, canRetry, cancel, owns };
}
