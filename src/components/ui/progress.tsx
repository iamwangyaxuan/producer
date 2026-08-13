import { Progress as BaseProgress } from "@base-ui/react/progress";
import { cn } from "tailwind-variants";

export interface ProgressProps {
  /** Current value, in the same unit as `max`. */
  value: number;
  /** The value that reads as a full bar. Defaults to 100. */
  max?: number;
  /**
   * What this bar measures, for screen readers — the visual is just a line,
   * so without a name `aria-valuenow` is a number about nothing.
   */
  "aria-label"?: string;
  className?: string;
  trackClassName?: string;
  indicatorClassName?: string;
}

/**
 * The app's hairline progress bar over Base UI's machinery: Base computes the
 * percentage and speaks `progressbar` to assistive tech, this wrapper says
 * how the bar looks — four pixels, fully rounded, in the neutral family the
 * audio player introduced. Callers restate only the colours that differ on
 * their surface (the video transport brightens both ends to sit on a scrim).
 *
 * Presentation only, by the same division of labour as the players': how a
 * press on the bar should be interpreted — seeking, usually — belongs to the
 * element wrapping it, which also owns the padded hit area a 4px line could
 * never offer.
 */
export default function Progress({
  value,
  max = 100,
  "aria-label": ariaLabel,
  className,
  trackClassName,
  indicatorClassName
}: ProgressProps) {
  return (
    <BaseProgress.Root value={value} max={max} aria-label={ariaLabel} className={className}>
      <BaseProgress.Track
        className={cn(
          "h-1 overflow-hidden rounded-full bg-[rgba(218,220,224,0.12)]",
          trackClassName
        )}
      >
        <BaseProgress.Indicator
          className={cn("h-full rounded-full bg-[rgba(218,220,224,0.55)]", indicatorClassName)}
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}
