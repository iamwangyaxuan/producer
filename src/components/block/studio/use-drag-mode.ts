import { useKeyPress } from "@xyflow/react";
import { useEffect } from "react";

/**
 * The space bar as "move things around", shared by every canvas in this app.
 *
 * It lives in a hook because both canvases need the *same* answer, not merely a
 * similar one: the archived board is read-only, but it is still a board, and a
 * viewer whose pointer and wheel behave differently from the editor's is a
 * second set of gestures to learn for no reason. Two copies of this drifted
 * once already.
 *
 * At rest the wheel pans — panning is the constant gesture on a board, and a
 * wheel that zooms by default keeps yanking the world out from under the
 * pointer. With the key down, dragging pans and the wheel zooms instead. The
 * caller wires that into React Flow's props and into `DragModeContext`, which
 * is what lets a node decide whether hovering it should offer to move it.
 *
 * React Flow's own hook rather than a hand-rolled listener: it already ignores
 * typing in inputs, prevents the page scroll, and lets go when the window
 * loses focus.
 */
export function useDragMode() {
  const dragMode = useKeyPress("Space");

  /**
   * The one thing that hook deliberately does not do: on a focused button it
   * leaves the browser's default alone — `useKeyPress` skips `preventDefault`
   * when the event target is a BUTTON or an A, on purpose, so that a canvas
   * cannot quietly break the keyboard on its own toolbar. There is no option to
   * turn that off, so a canvas that means something else by the space bar has
   * to say so itself.
   *
   * Here it has to. The focus is usually still sitting on a toolbar button
   * without anyone realising: closing a menu hands focus back to the trigger it
   * was opened from, and a pointer never lights the focus ring, so the button
   * looks idle while the browser still treats it as the one being typed at. The
   * space bar then does both jobs — enter drag mode, and press that button on
   * release.
   *
   * It has to be `preventDefault` rather than dropping the focus. Both stop the
   * press on keyup, but the browser marks the button `:active` *after* the
   * keydown is dispatched — later than any handler or effect that could blur
   * it. Blurring therefore left `:active` set on an element that no longer had
   * focus, and keyup went to the body instead, so nothing ever cleared it:
   * `active:blur-[1.5px]` stayed on and the button was left permanently
   * smudged until someone pressed a mouse button on it again. Preventing the
   * default kills the `:active` and the click at the one moment that governs
   * both, and leaves the focus where the keyboard user put it.
   *
   * Capture, because a trigger may stop the keydown from reaching the document.
   * Enter still activates buttons and still opens menus, which is what keeps
   * this from being a keyboard dead end.
   */
  useEffect(() => {
    const swallowSpace = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        event.code === "Space" &&
        target instanceof HTMLElement &&
        (target.tagName === "BUTTON" || target.tagName === "A")
      ) {
        event.preventDefault();
      }
    };

    document.addEventListener("keydown", swallowSpace, true);

    return () => document.removeEventListener("keydown", swallowSpace, true);
  }, []);

  return dragMode;
}

/**
 * What React Flow has to be told to make the above true, in one object so the
 * two canvases cannot configure it differently.
 *
 * `panActivationKeyCode: null` is the load-bearing one. React Flow's own
 * space-bar shortcut forces `panOnScroll` back on while that key is down,
 * quietly overriding the two props beside it and turning the drag-mode wheel
 * back into a pan. This canvas already gives the space bar its meaning itself.
 */
export function dragModeProps(dragMode: boolean) {
  return {
    panOnDrag: dragMode,
    panOnScroll: !dragMode,
    zoomOnScroll: dragMode,
    panActivationKeyCode: null,
    // A double-click is a gesture nodes get to mean things with (and misfire on
    // — two fast clicks on a video's transport); the camera lurching in on
    // every one made it unusable for both.
    zoomOnDoubleClick: false
  } as const;
}
