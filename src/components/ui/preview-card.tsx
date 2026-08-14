import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";

import { mergeClassName } from "#/components/ui/class-name";

/**
 * A card that opens on hover, for showing what something *is* without asking
 * anyone to click it.
 *
 * Base UI keeps this separate from `Popover` on purpose, and the difference is
 * not the trigger: a preview card is not a dialog, so it takes no focus, traps
 * none, and closes when the pointer leaves. That is what makes it safe to hang
 * off something inside a text editor — a popover would steal the caret out of
 * the sentence being written, mid-word.
 */
export const PreviewCardRoot = BasePreviewCard.Root;

export interface PreviewCardContentProps extends BasePreviewCard.Popup.Props {
  positioner?: BasePreviewCard.Positioner.Props;
}

/**
 * Same material as the menu popup — this floats over the same canvas and there
 * is no reason for two kinds of glass on one surface.
 */
export function PreviewCardContent({ positioner, className, ...props }: PreviewCardContentProps) {
  return (
    <BasePreviewCard.Portal>
      <BasePreviewCard.Positioner
        side="top"
        align="center"
        sideOffset={8}
        {...positioner}
        className={mergeClassName("z-50 outline-hidden", positioner?.className)}
      >
        <BasePreviewCard.Popup
          {...props}
          className={mergeClassName(
            "w-64 origin-(--transform-origin) overflow-hidden rounded-2xl bg-[rgba(22,23,24,0.9)] text-foreground shadow-[0_16px_40px_rgba(0,0,0,0.45)] outline-hidden backdrop-blur-2xl transition-[transform,opacity] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            className
          )}
        />
      </BasePreviewCard.Positioner>
    </BasePreviewCard.Portal>
  );
}

/**
 * Base UI waits 600ms before opening and 300ms before closing. That default is
 * tuned for a link in a page of prose, where a card on every passing hover
 * would be noise; here the trigger is a chip someone deliberately points at,
 * and at 600ms the card reads as broken rather than considered. Short enough
 * to feel immediate, long enough that sweeping across a line of chips does not
 * flash one card per chip.
 */
export function PreviewCardTrigger(props: BasePreviewCard.Trigger.Props) {
  return <BasePreviewCard.Trigger delay={120} closeDelay={80} {...props} />;
}

const PreviewCard = {
  Root: PreviewCardRoot,
  Trigger: PreviewCardTrigger,
  Content: PreviewCardContent
};

export default PreviewCard;
