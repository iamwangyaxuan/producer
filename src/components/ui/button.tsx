import { Button as BaseButton } from "@base-ui/react/button";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

import { mergeClassName } from "#/components/ui/class-name";
import type { ClassName } from "#/components/ui/class-name";
import Icon from "#/components/ui/icon";

/**
 * Styling hangs off `data-disabled` rather than `:disabled`, because a button
 * that is disabled while it waits on the server keeps its focus instead of the
 * `disabled` attribute — see {@link ButtonProps.pending}. `data-disabled` is the
 * one signal Base UI sets in both cases.
 *
 * `active:blur-[1.5px]` is the same press the menu rows use; it is what makes a
 * button feel like it belongs to the same surface as the menu it was opened
 * from.
 */
const buttonClass = tv({
  base: [
    "inline-flex shrink-0 cursor-default items-center justify-center",
    "font-medium whitespace-nowrap select-none",
    "transition-colors duration-100",
    // Deliberately no `outline-hidden` alongside these: it sets
    // `--tw-outline-style: none`, which is the variable `outline-2` then reads
    // for its own `outline-style` — the ring would come out 2px wide, offset,
    // coloured, and invisible. A button has no outline at rest anyway.
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-50",
    "active:blur-[1.5px]",
    "data-disabled:pointer-events-none"
  ],
  variants: {
    variant: {
      primary: "bg-neutral-50 text-neutral-950 hover:bg-white",
      secondary: "bg-[rgba(218,220,224,0.08)] text-foreground hover:bg-[rgba(218,220,224,0.12)]",
      outline: [
        "border border-[rgba(218,220,224,0.1)] text-foreground",
        "hover:border-[rgba(218,220,224,0.2)] hover:bg-[rgba(218,220,224,0.05)]"
      ],
      ghost: "text-neutral-300 hover:bg-[rgba(218,220,224,0.08)] hover:text-foreground",
      danger: "bg-red-500 text-white hover:bg-red-400"
    },
    size: {
      sm: "h-6 gap-1 rounded-lg px-2 text-[11px] leading-4",
      md: "h-7 gap-1.5 rounded-xl px-3 text-[13px] leading-4",
      lg: "h-9 gap-2 rounded-2xl px-4 text-sm leading-5"
    },
    /**
     * `aspect-square` rather than a width per size: the height is already fixed,
     * so one rule squares off all three of them.
     */
    icon: {
      true: "aspect-square px-0"
    },
    /**
     * Corners only. What turns `rounded-full` into a circle rather than a pill
     * is the equal width and height, and that comes from `icon` — so this stays
     * useful on its own for a pill-shaped button that still has a label.
     *
     * `square` carries no classes because each size already ships the radius
     * that suits its height. It is spelled out anyway so that the default is
     * written down somewhere rather than implied by the absence of a value.
     */
    shape: {
      square: "",
      circle: "rounded-full"
    },
    /**
     * A pending button is disabled, but it should not be dimmed like one — the
     * spinner already says why it cannot be pressed, and a half-faded spinner
     * reads as broken rather than as busy. So the dimming lives in the `false`
     * case instead of sitting in `base` and being overridden here, which keeps
     * it out of a class-order tiebreak.
     */
    pending: {
      false: "data-disabled:opacity-50"
    }
  },
  defaultVariants: {
    variant: "primary",
    size: "md",
    shape: "square",
    pending: false
  }
});

export interface ButtonProps extends BaseButton.Props, VariantProps<typeof buttonClass> {
  /**
   * Disables the button and puts a spinner in front of its label.
   *
   * The button stays focusable while it is pending — `aria-disabled` instead of
   * the `disabled` attribute — because a button that drops focus the moment it
   * is pressed leaves a keyboard or screen reader user back at the top of the
   * document, with nothing to tell them the press even landed. Base UI still
   * swallows the click, so a `type="submit"` button will not submit.
   */
  pending?: boolean;
}

/**
 * Composes over Base UI's button, so `render` still works: pass
 * `render={<Link to="…" />}` together with `nativeButton={false}` to get the
 * button's look on something that is really a link.
 */
export default function Button({
  variant,
  size,
  icon,
  shape,
  pending = false,
  disabled,
  focusableWhenDisabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      {...props}
      disabled={disabled || pending}
      focusableWhenDisabled={focusableWhenDisabled ?? pending}
      aria-busy={pending || undefined}
      className={mergeClassName(
        buttonClass({ variant, size, icon, shape, pending }),
        className as ClassName<BaseButton.State>
      )}
    >
      {pending ? (
        <>
          <Icon name="progress_activity" className="animate-spin text-[1.25em]" />
          {/* An icon button has no room for both, so while it is pending the
              spinner stands in for the icon rather than being wedged beside it. */}
          {icon ? null : children}
        </>
      ) : (
        children
      )}
    </BaseButton>
  );
}
