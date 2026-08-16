import type { ReactNode } from "react";

/**
 * The card every signed-out page is drawn on, and the class lists they share.
 *
 * These pages live outside `_auth` and outside the app's dark-only surface:
 * they are the first thing a stranger sees, and they follow the system theme
 * rather than asserting one. That is why none of this reuses
 * `components/ui/button` — those are built for the dark canvas, in a palette
 * that has no light half.
 *
 * The five pages (sign in, sign up, forgot, reset, verify) were going to copy
 * these strings between them, which is the way a focus ring ends up a different
 * blue on the page nobody looked at twice.
 */

export const LABEL_CLASS = "block text-sm font-medium text-neutral-700 dark:text-neutral-300";

/**
 * `read-only` rather than `disabled` while a request is in flight, for the
 * reason the buttons below use `aria-disabled`: a disabled control drops focus,
 * which leaves a keyboard or screen reader user back at the top of the document
 * at the exact moment there is something to tell them.
 *
 * Deliberately without `transition`. Tailwind's bare one covers `border-color`,
 * and these fields sit one above the other: moving between them would fade the
 * border of the field being left out over 150ms while the border of the field
 * being entered faded in, so for that moment the *old* field is the brighter of
 * the two and the focus reads as lagging a step behind the pointer. A focus
 * indicator is the one thing that has to land at once.
 */
export const INPUT_CLASS = [
  "mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2",
  "text-sm text-neutral-900 outline-hidden placeholder:text-neutral-400",
  "focus-visible:border-neutral-900 read-only:opacity-60",
  "dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50",
  "dark:placeholder:text-neutral-500 dark:focus-visible:border-neutral-400"
].join(" ");

/**
 * `aria-disabled` plus `pointer-events-none` instead of the `disabled`
 * attribute: the button keeps its focus while the request is in flight, and
 * each submit handler guards the keyboard path that a non-disabled submit
 * button still leaves open.
 */
const BUTTON_BASE_CLASS = [
  "flex w-full items-center justify-center gap-3 rounded-lg px-4 py-2.5",
  // `transition-colors`, the way the shared button does it, rather than the bare
  // `transition`: that one also lists `pointer-events`, a discrete property that
  // flips half way through — the row below would keep taking clicks for 75ms
  // after it had been told to stop.
  "text-sm font-medium transition-colors",
  // The one colour here that does not come in a light and a dark flavour: the
  // focus ring is the same blue on both, so it stays the single thing on screen
  // that always means "this is where the keyboard is" instead of borrowing each
  // theme's own foreground and having to be told apart from it.
  //
  // Unconditional, not behind `focus-visible:` — `transition-colors` above
  // covers `outline-color`, and a ring that only picks up its colour on focus
  // animates there from `currentColor` while the reader watches.
  "outline-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2",
  "aria-disabled:pointer-events-none aria-disabled:opacity-60"
].join(" ");

export const SUBMIT_CLASS = [
  BUTTON_BASE_CLASS,
  "bg-neutral-900 text-white hover:bg-neutral-800",
  "dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-white"
].join(" ");

export const SECONDARY_CLASS = [
  BUTTON_BASE_CLASS,
  "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50",
  "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:bg-neutral-800"
].join(" ");

/** For the "no account? sign up" line under a form, not for a button. */
export const LINK_CLASS = [
  "rounded-sm font-medium text-neutral-900 underline-offset-2 hover:underline",
  "outline-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2",
  "dark:text-neutral-50"
].join(" ");

export interface AuthShellProps {
  title: string;
  description?: ReactNode;
  /**
   * Shown above the form. Above rather than beside a field because most of
   * these messages belong to the request as a whole — a wrong password, a dead
   * token, a rejected address — and some of these pages have no field for it to
   * sit beside.
   */
  error?: string | null;
  /** The reassuring counterpart: "check your email", "password changed". */
  notice?: ReactNode;
  children?: ReactNode;
  /** The line under the card — links to the other signed-out pages. */
  footer?: ReactNode;
}

export function AuthShell({ title, description, error, notice, children, footer }: AuthShellProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-10 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <div className="rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{title}</h1>
          {description ? (
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">{description}</p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400"
            >
              {error}
            </p>
          ) : null}

          {/*
           * `role="status"` rather than `alert`: these are confirmations, and a
           * screen reader should hear them without having the current sentence
           * interrupted the way an assertive announcement does.
           */}
          {notice ? (
            <p
              role="status"
              className="mt-6 rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {notice}
            </p>
          ) : null}

          {children}
        </div>

        {footer ? (
          <p className="mt-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
            {footer}
          </p>
        ) : null}
      </div>
    </main>
  );
}
