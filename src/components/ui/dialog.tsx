import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";

function mergeClassName(preset: string, className: string | undefined) {
  return [preset, className].filter(Boolean).join(" ");
}

/**
 * The scrim blurs the page rather than only dimming it, and grows the blur in
 * on `--ease-spring` (see `styles.css`) over the 450ms that curve was solved
 * for. What the rest of the class list is doing:
 *
 * 6px is a soft focus rather than frosted glass, and deliberately so: the scrim
 * over it is already opaque enough to separate the dialog from the page on its
 * own, so the blur only has to take the edge off what shows through. Radii in
 * the double digits — the popup's own 40px, say — are for a surface that has to
 * become its own background; here that would just erase the page.
 *
 * The starting and ending blur is `[0px]`, not `-none`. `backdrop-blur-none`
 * clears Tailwind's filter variable, leaving `backdrop-filter: none` — which
 * browsers only interpolate against a real `blur()` by way of a spec fallback,
 * whereas `blur(0px)` is the same value written so no fallback is involved.
 *
 * Only the entrance springs. A transition takes its timing from the state it is
 * heading into, so the `data-ending-style` duration and easing are the ones
 * that run on the way out — 150ms, no overshoot. A spring closing would spend
 * its overshoot below zero blur and below zero opacity, where both clamp: the
 * dialog would look finished and then hold there while the timer ran down. A
 * dismissal should also just be quicker than an arrival.
 *
 * `-webkit-backdrop-filter` is named alongside the standard property because
 * Tailwind still emits the prefixed declaration and Safari only dropped the
 * prefix in 18. `transition-property` takes property names it does not
 * recognise without complaint, so listing both costs the engines that need
 * neither anything.
 */
const BACKDROP_CLASS =
  "fixed inset-0 z-50 bg-black/60 backdrop-blur-[6px] transition-[opacity,backdrop-filter,-webkit-backdrop-filter] duration-450 ease-spring data-starting-style:opacity-0 data-starting-style:backdrop-blur-[0px] data-ending-style:opacity-0 data-ending-style:backdrop-blur-[0px] data-ending-style:duration-150 data-ending-style:ease-out";

const VIEWPORT_CLASS = "fixed inset-0 z-50 grid place-items-center p-4";

/**
 * On the same spring and the same 450ms as the backdrop. A popup that kept its
 * old 150ms would be sitting still for two thirds of the time the page behind
 * it was still going soft, which reads as two unrelated animations that happen
 * to have been triggered together rather than one surface arriving.
 */
const POPUP_CLASS =
  "max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-[18px] bg-[rgba(22,23,24,0.9)] p-5 text-foreground shadow-[0_16px_40px_rgba(0,0,0,0.45)] outline-hidden backdrop-blur-[40px] transition-[opacity,scale] duration-450 ease-spring data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-150 data-ending-style:ease-out";

const TITLE_CLASS = "text-foreground text-base font-medium";

const DESCRIPTION_CLASS = "mt-2 text-sm text-neutral-400";

export interface DialogContentProps extends Omit<BaseDialog.Popup.Props, "className"> {
  className?: string;
  container?: BaseDialog.Portal.Props["container"];
  keepMounted?: boolean;
}

export function DialogContent({ container, keepMounted, className, ...props }: DialogContentProps) {
  return (
    <BaseDialog.Portal container={container} keepMounted={keepMounted}>
      <BaseDialog.Backdrop className={BACKDROP_CLASS} />
      <BaseDialog.Viewport className={VIEWPORT_CLASS}>
        <BaseDialog.Popup {...props} className={mergeClassName(POPUP_CLASS, className)} />
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: Omit<BaseDialog.Title.Props, "className"> & { className?: string }) {
  return <BaseDialog.Title {...props} className={mergeClassName(TITLE_CLASS, className)} />;
}

export function DialogDescription({
  className,
  ...props
}: Omit<BaseDialog.Description.Props, "className"> & { className?: string }) {
  return (
    <BaseDialog.Description {...props} className={mergeClassName(DESCRIPTION_CLASS, className)} />
  );
}

const Dialog = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Close: BaseDialog.Close,
  Content: DialogContent,
  Title: DialogTitle,
  Description: DialogDescription,
  /** Connects a `Dialog.Root` to triggers rendered outside of it. */
  createHandle: BaseDialog.createHandle
};

export const AlertDialog = {
  Root: BaseAlertDialog.Root,
  Trigger: BaseAlertDialog.Trigger,
  Close: BaseDialog.Close,
  Content: DialogContent,
  Title: DialogTitle,
  Description: DialogDescription,
  createHandle: BaseAlertDialog.createHandle
};

export default Dialog;
