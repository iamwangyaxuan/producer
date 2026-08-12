import { useOnViewportChange, useReactFlow } from "@xyflow/react";
import type { Viewport } from "@xyflow/react";
import { useEffect } from "react";

/**
 * Where this person left the camera, per project and per browser.
 *
 * The viewport is deliberately not part of the shared document: it is the one
 * piece of canvas state that is *supposed* to differ between people looking at
 * the same board, so it lives in localStorage — restored after mount rather
 * than through `defaultViewport`, because the route renders on the server
 * where there is no storage to read and no viewport worth guessing at.
 */
export function useViewportMemory(projectId: string) {
  const { setViewport } = useReactFlow();

  useEffect(() => {
    const raw = localStorage.getItem(storageKey(projectId));

    if (!raw) return;

    try {
      const saved: unknown = JSON.parse(raw);

      if (isViewport(saved)) void setViewport(saved);
    } catch {
      // A corrupt entry restores nothing, which is the default view anyway.
    }
  }, [projectId, setViewport]);

  useOnViewportChange({
    // The end of a pan or zoom rather than every frame of one: localStorage
    // writes are synchronous, and a gesture should not pay for one per frame.
    onEnd: (viewport) => {
      try {
        localStorage.setItem(storageKey(projectId), JSON.stringify(viewport));
      } catch {
        // Storage can be full or blocked; losing the camera position is fine.
      }
    }
  });
}

function storageKey(projectId: string) {
  return `producer:canvas:${projectId}:viewport`;
}

function isViewport(value: unknown): value is Viewport {
  if (typeof value !== "object" || value === null) return false;

  const viewport = value as Record<string, unknown>;

  return (
    typeof viewport.x === "number" &&
    typeof viewport.y === "number" &&
    typeof viewport.zoom === "number" &&
    viewport.zoom > 0
  );
}
