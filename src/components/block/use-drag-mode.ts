import { useEffect, useState } from "react";

function typing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement)
  );
}

/**
 * Whether the space bar is being held, which is what puts the canvas into its
 * move-things-around mode: panning and node dragging both wait for it, so a
 * stray drag cannot shove the work about.
 *
 * Held-key state rather than a toggle, so there is no mode to get stuck in and
 * nothing to remember — the canvas is only movable while you are asking for it.
 */
export function useDragMode() {
  const [dragMode, setDragMode] = useState(false);

  useEffect(() => {
    function sync(event: KeyboardEvent, held: boolean) {
      if (event.code !== "Space") return;

      // The composer sits on this canvas. A space typed into it is a word break,
      // not a request to move the view — and this has to come before the
      // `preventDefault` below, or writing a prompt would stop working.
      if (typing(event.target)) return;

      // Otherwise the page scrolls and any focused button fires.
      event.preventDefault();
      setDragMode(held);
    }

    const down = (event: KeyboardEvent) => sync(event, true);
    const up = (event: KeyboardEvent) => sync(event, false);
    // Tabbing away leaves the key down as far as this window ever hears, so a
    // lost focus has to count as a release or the canvas stays in drag mode.
    const release = () => setDragMode(false);

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);

    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  return dragMode;
}
