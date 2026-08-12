import { useRef } from "react";

import type { ComposerSubmission } from "#/components/block/studio/ai-composer";
import type { GenerationNodeData } from "#/components/block/studio/generation-node";
import { requestGeneration } from "#/lib/sample-media";

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
    submission: ComposerSubmission,
    patch: (id: string, data: Partial<GenerationNodeData>) => void
  ) {
    const controller = new AbortController();
    inFlight.current.set(id, controller);

    try {
      const src = await requestGeneration(submission, controller.signal);

      patch(id, { src, status: "ready" });
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
