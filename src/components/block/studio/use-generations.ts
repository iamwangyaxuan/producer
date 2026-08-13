import { useRef } from "react";

import type { ComposerSubmission } from "#/components/block/studio/ai-composer";
import type { GenerationNodeData } from "#/components/block/studio/generation-node";
import { runGeneration, startGeneration } from "#/lib/generate-asset";

/**
 * The requests still in flight, kept apart from the canvas so deleting a node —
 * locally or from another machine — can call off its work without the canvas
 * knowing how the work is done.
 */
export function useGenerations() {
  /** One per request still in flight, so deleting a node can call off its work. */
  const inFlight = useRef(new Map<string, AbortController>());

  async function start(
    id: string,
    projectId: string,
    submission: ComposerSubmission,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    const controller = new AbortController();
    inFlight.current.set(id, controller);

    try {
      // Two calls, and the seam between them is the point: the first only
      // creates the asset record and answers with its id, which lands on the
      // node *before* any model runs. From that moment the node and the row
      // name each other — deleting the node mid-generation deletes the asset
      // by id, and the server's completion bind notices and discards the
      // bytes instead of leaving an unowned file behind.
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
        signal: controller.signal
      });

      patch(id, { assetId });

      // The slow half: provider, R2, and the guarded bind of bytes to row.
      // Everything the model needs was recorded by the first call, so this
      // carries nothing but the id.
      const { url, mimeType } = await runGeneration({
        data: { assetId },
        signal: controller.signal
      });

      patch(id, { src: url, mimeType, status: "ready" });
    } catch {
      // A cancelled request belongs to a node that is already gone; marking it
      // failed would be describing something nobody can see.
      if (!controller.signal.aborted) patch(id, { status: "failed" });
    } finally {
      inFlight.current.delete(id);
    }
  }

  function cancel(ids: readonly string[]) {
    for (const id of ids) {
      inFlight.current.get(id)?.abort();
      inFlight.current.delete(id);
    }
  }

  /** Whether this client is the one still working on the node. */
  function owns(id: string) {
    return inFlight.current.has(id);
  }

  return { start, cancel, owns };
}
