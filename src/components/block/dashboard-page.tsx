import type { ReactNode } from "react";

import Icon from "#/components/ui/icon";

/**
 * The chrome every page under `_dashboard` wears: the padding, the column it
 * sits in, and the heading at the top of it.
 *
 * It exists because three pages had each grown their own copy — the same
 * `px-4 py-8 sm:px-6 lg:px-10`, the same `text-2xl font-semibold`, the same
 * error panel — and had already drifted apart on the one thing that genuinely
 * differs between them. Once a fourth page was being added, the choice was to
 * copy it a fourth time or to name it once, and a shared shell also means a new
 * page lines up with the others by construction rather than by whoever wrote it
 * remembering to look.
 *
 * What is *not* shared is the width, because that is a real decision per page
 * rather than an accident — see {@link PageWidth}.
 */

/**
 * How wide the column is allowed to get.
 *
 * The three values are the three shapes of content this app has, and the reason
 * a single number would be wrong: a grid of project cards wants every column it
 * can be given, two stacks of billing cards read badly past a point, and a list
 * of one-line rows becomes hard to follow when the eye has to travel from a
 * name on the far left to a control on the far right.
 */
export type PageWidth = "narrow" | "regular" | "wide";

const WIDTH_CLASS: Record<PageWidth, string> = {
  narrow: "max-w-3xl",
  regular: "max-w-4xl",
  wide: "max-w-7xl"
};

/** No background of its own — `styles.css` already paints the body. */
const PAGE_CLASS = "px-4 py-8 sm:px-6 lg:px-10";

/**
 * A container query rather than viewport breakpoints: the dashboard shell has a
 * sidebar, which changes how much room a page has without changing the width of
 * the window.
 */
const CONTENT_CLASS = "@container mx-auto w-full";

export const PAGE_TITLE_CLASS = "text-2xl font-semibold tracking-tight text-foreground";

export const PAGE_SUBTITLE_CLASS = "mt-1 text-sm text-neutral-400";

/** The heading inside a {@link PageCard}. */
export const SECTION_TITLE_CLASS = "text-sm font-medium text-foreground";

/** The surface every panel on these pages is drawn on. */
export const CARD_CLASS =
  "rounded-[18px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.03)] p-5";

/**
 * The bare input these pages use. There is no `Input` component in
 * `components/ui` — the sign-in pages have their own because they follow the
 * system theme, and this is the dark-canvas half of that split.
 */
export const INPUT_CLASS = [
  "text-foreground w-full rounded-[12px] border border-[rgba(218,220,224,0.1)]",
  "bg-[rgba(218,220,224,0.05)] px-3 py-2 text-sm outline-hidden transition",
  "placeholder:text-neutral-500 focus-visible:border-neutral-500 disabled:opacity-50"
].join(" ");

const RETRY_CLASS = [
  "shrink-0 rounded-md border border-neutral-700 px-2.5 py-1 text-sm font-medium",
  "text-foreground transition hover:bg-neutral-800",
  // Colour first and unconditionally: `transition` covers `outline-color` too,
  // so a ring that gets its colour from the `focus-visible:` prefix fades in
  // from `currentColor` instead of arriving blue.
  "outline-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2"
].join(" ");

export interface DashboardPageProps {
  title: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** The page's primary control, laid out opposite the title. */
  actions?: ReactNode;
  width?: PageWidth;
  children?: ReactNode;
}

export function DashboardPage({
  title,
  description,
  actions,
  width = "regular",
  children
}: DashboardPageProps) {
  return (
    <div className={PAGE_CLASS}>
      <div className={`${CONTENT_CLASS} ${WIDTH_CLASS[width]}`}>
        {/*
         * `items-start` rather than centring: the title block can wrap to two
         * lines while the action beside it is always one, and a button that
         * drifts to the vertical middle of a wrapped heading reads as
         * belonging to neither line.
         */}
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className={PAGE_TITLE_CLASS}>{title}</h1>
            {description ? <p className={PAGE_SUBTITLE_CLASS}>{description}</p> : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </header>

        {children}
      </div>
    </div>
  );
}

export function PageCard({
  children,
  className = ""
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`${CARD_CLASS} ${className}`}>{children}</section>;
}

/**
 * What a page shows when its data would not load.
 *
 * The message is split in two on purpose: a line naming what failed, which is
 * the page's to write, and the reason, which is only ever shown in full during
 * development — a failed server function can carry a connection string or a
 * fragment of SQL.
 */
export function PageErrorPanel({
  title,
  error,
  onRetry
}: {
  title: string;
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mt-8 flex items-start gap-3 rounded-xl border border-red-900/60 bg-red-950/40 p-4"
    >
      <Icon name="error" className="text-2xl text-red-400" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        <p className="text-sm text-neutral-400">
          {import.meta.env.DEV ? error.message : "Something went wrong on our side."}
        </p>
      </div>
      <button type="button" onClick={onRetry} className={RETRY_CLASS}>
        Try again
      </button>
    </div>
  );
}
