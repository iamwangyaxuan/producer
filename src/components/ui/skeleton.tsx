import type { ComponentProps } from "react";
import { cn } from "tailwind-variants";

/**
 * A placeholder that holds the space its content will land in.
 *
 * `aria-hidden` because a skeleton has nothing to read out — the element that
 * owns it should carry `aria-busy` and a label instead, so the pending state is
 * announced once rather than as a shape per box.
 *
 * No size of its own: the caller decides, and for media that means giving the
 * box the aspect ratio the result will have. Sizing it here would guarantee the
 * layout jumps at the moment the content arrives, which is the one thing a
 * skeleton exists to prevent.
 *
 * The fill is opaque and the pulse is a colour change, not a fade — see
 * `--animate-skeleton`. A placeholder that goes half-transparent on every beat
 * shows whatever is behind it, which on a canvas is a moving dot grid.
 */
export default function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      {...props}
      className={cn("animate-skeleton rounded-xl bg-[#1a1b1d]", className)}
    />
  );
}
