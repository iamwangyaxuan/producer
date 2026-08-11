import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";

function mergeClassName(preset: string, className: string | undefined) {
  return [preset, className].filter(Boolean).join(" ");
}

const BACKDROP_CLASS =
  "fixed inset-0 z-50 bg-black/60 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0";

const VIEWPORT_CLASS = "fixed inset-0 z-50 grid place-items-center p-4";

const POPUP_CLASS =
  "max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-[18px] bg-[rgba(22,23,24,0.9)] p-5 text-foreground shadow-[0_16px_40px_rgba(0,0,0,0.45)] outline-hidden backdrop-blur-[40px] transition-[opacity,scale] duration-150 ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

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
