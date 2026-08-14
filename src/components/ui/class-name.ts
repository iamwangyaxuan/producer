import { cn } from "tailwind-variants";

/**
 * Base UI lets a part's `className` be either a string or a function of that
 * part's state, and every wrapper in this folder has to accept both to stay a
 * drop-in for the part it wraps.
 */
export type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

/**
 * A wrapper's own preset merged with whatever the caller passed, in either
 * form. Through `cn`, so a caller's utility wins the conflict with the preset
 * rather than both landing in the class list and letting source order decide.
 *
 * `dialog.tsx` keeps a version of its own on purpose — it joins rather than
 * merges, which is a different answer to that same conflict.
 */
export function mergeClassName<State>(
  preset: string,
  className: ClassName<State>
): ClassName<State> {
  if (typeof className !== "function") return cn(preset, className);

  return (state) => cn(preset, className(state));
}
