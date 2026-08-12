import { useId } from "react";
import type { FormEvent, ReactNode } from "react";

import Button from "#/components/ui/button";
import Dialog, { AlertDialog } from "#/components/ui/dialog";
import { PROJECT_NAME_MAX_LENGTH } from "#/lib/projects";

/*
 * The dialogs a project's actions open, shared by the card in the projects grid
 * and by the studio's header. They own neither the mutation nor the state that
 * decides which one is showing: both callers already hold that, and they hold
 * different amounts of it — the grid can also archive, while the studio has to
 * leave the page it is on once the project it is showing is gone.
 */

export interface RenameDialogProps {
  open: boolean;
  onClose: () => void;
  value: string;
  onValueChange: (value: string) => void;
  /** Handed the trimmed name, and only when there is one. */
  onSubmit: (name: string) => void;
  error: Error | null;
  pending: boolean;
}

/**
 * Dismissible, unlike the confirmation below it: nothing has happened yet, and
 * the draft is thrown away either way.
 */
export function RenameDialog({
  open,
  onClose,
  value,
  onValueChange,
  onSubmit,
  error,
  pending
}: RenameDialogProps) {
  const inputId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const next = value.trim();

    // The submit button is disabled in both cases; this is the keyboard path to
    // the same submit, which a disabled button does not always intercept.
    if (!next || pending) return;

    onSubmit(next);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Content>
        <form onSubmit={submit}>
          <Dialog.Title>Rename project</Dialog.Title>
          <label htmlFor={inputId} className="mt-4 block text-sm text-neutral-400">
            Name
          </label>
          <input
            id={inputId}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            placeholder="Untitled project"
            disabled={pending}
            className="text-foreground mt-1.5 w-full rounded-[12px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.05)] px-3 py-2 text-sm outline-hidden transition placeholder:text-neutral-500 focus-visible:border-neutral-500 disabled:opacity-50"
          />
          <ActionError error={error} />
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close disabled={pending} render={<Button variant="ghost" />}>
              Cancel
            </Dialog.Close>
            {/* `pending` rather than `disabled` while the rename is in flight:
                the button keeps focus and Base UI swallows the click anyway, so
                nothing submits twice. */}
            <Button type="submit" pending={pending} disabled={value.trim() === ""}>
              Rename
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Paints the confirm button red; for the one that destroys something. */
  destructive?: boolean;
  error: Error | null;
  pending: boolean;
  onConfirm: () => void;
}

/**
 * An alert dialog rather than a plain one, so the decision has to be taken or
 * declined — clicking away from it does nothing.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive,
  error,
  pending,
  onConfirm
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <AlertDialog.Content>
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description}</AlertDialog.Description>
        <ActionError error={error} />
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialog.Close disabled={pending} render={<Button variant="ghost" />}>
            Cancel
          </AlertDialog.Close>
          <Button
            variant={destructive ? "danger" : "primary"}
            pending={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/**
 * A failed server function can carry driver-level detail — a connection string,
 * a fragment of SQL — so only the development build shows the original message,
 * the same trade the projects route makes.
 */
function ActionError({ error }: { error: Error | null }) {
  if (!error) return null;

  return (
    <p role="alert" className="mt-3 text-sm text-red-400">
      {import.meta.env.DEV ? error.message : "Something went wrong. Please try again."}
    </p>
  );
}
