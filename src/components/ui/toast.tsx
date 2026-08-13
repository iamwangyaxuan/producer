import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";

import Icon from "#/components/ui/icon";

/**
 * Transient notices, in the surface language the canvas menus already speak:
 * a dark frosted card, small type, one line of reason.
 *
 * The provider used to be here on its own, which meant `useToastManager`
 * could queue a toast that had nowhere to appear. The viewport is what makes
 * it a working component rather than a promise of one.
 */
export default function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <ToastViewport />
    </Toast.Provider>
  );
}

function ToastViewport() {
  const { toasts } = Toast.useToastManager();

  return (
    <Toast.Portal>
      {/* Bottom-right, clear of the composer that owns the bottom centre and
          of the toolbar in the top-left. `pointer-events-none` on the frame
          so a stack of notices never becomes a wall across the canvas; the
          cards themselves take their own presses back. */}
      <Toast.Viewport className="pointer-events-none fixed right-0 bottom-0 z-50 flex w-full max-w-sm flex-col gap-2 p-6">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            className={[
              "pointer-events-auto flex items-start gap-2 rounded-[18px] bg-[rgba(22,23,24,0.9)] p-3 text-foreground",
              "shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl",
              "transition-[transform,opacity] duration-150 ease-out",
              "data-starting-style:scale-95 data-starting-style:opacity-0",
              "data-ending-style:scale-95 data-ending-style:opacity-0"
            ].join(" ")}
          >
            <Icon
              name={toast.type === "error" ? "error" : "info"}
              className={[
                "mt-px shrink-0 text-sm",
                toast.type === "error" ? "text-red-400" : "text-neutral-400"
              ].join(" ")}
            />

            <div className="min-w-0 flex-1">
              <Toast.Title className="text-[11px] leading-4 font-medium" />
              <Toast.Description className="text-[11px] leading-4 text-neutral-400" />
            </div>

            <Toast.Close
              aria-label="Dismiss"
              className="-m-1 shrink-0 cursor-default rounded-lg p-1 text-neutral-500 transition-colors hover:bg-[rgba(218,220,224,0.05)] hover:text-neutral-300"
            >
              <Icon name="close" className="block text-sm" />
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
