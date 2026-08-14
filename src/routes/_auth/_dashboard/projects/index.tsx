import { Toast } from "@base-ui/react/toast";
import { useQueryErrorResetBoundary, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";

import ProjectCard, { ProjectCardSkeleton } from "#/components/block/project-card";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import { organizationProjectsQueryOptions, useCreateProject } from "#/lib/projects";
import type { OrganizationProjects } from "#/lib/projects";

export const Route = createFileRoute("/_auth/_dashboard/projects/")({
  /**
   * `_auth` has already resolved the session, so the active organization is
   * known before the first render. `ensureQueryData` rather than `prefetchQuery`
   * because the server render has to contain the real grid, and a failed read
   * has to reach the router so both sides of hydration agree on showing
   * `errorComponent` — a prefetch swallows the rejection, which is the classic
   * way to render an error on the server and a spinner in the browser.
   *
   * Nothing is returned on purpose: `router.tsx` wires up
   * `setupRouterSsrQueryIntegration`, so the query cache already carries the
   * rows to the client. Returning them would serialize the same list into the
   * document a second time as loader data.
   */
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(
      organizationProjectsQueryOptions(context.session.session.activeOrganizationId)
    );
  },
  pendingComponent: ProjectsPending,
  errorComponent: ProjectsError,
  component: RouteComponent
});

/** No background of its own — `styles.css` already paints the body. */
const PAGE_CLASS = "px-4 py-8 sm:px-6 lg:px-10";

/**
 * A container query rather than viewport breakpoints: the dashboard shell is
 * about to grow a sidebar, which shrinks how much room this grid has without
 * changing the width of the window.
 */
const CONTENT_CLASS = "@container mx-auto w-full max-w-7xl";

const GRID_CLASS =
  "grid grid-cols-1 gap-4 @lg:grid-cols-2 @3xl:grid-cols-3 @3xl:gap-6 @5xl:grid-cols-4";

const TITLE_CLASS = "text-2xl font-semibold tracking-tight text-foreground";

const SUBTITLE_CLASS = "mt-1 truncate text-sm text-neutral-400";

const PANEL_CLASS =
  "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-800 px-6 py-16 text-center";

const PANEL_ICON_CLASS =
  "flex size-12 items-center justify-center rounded-full bg-neutral-800 text-2xl text-neutral-400";

const ERROR_CLASS = "flex items-start gap-3 rounded-xl border border-red-900/60 bg-red-950/40 p-4";

const RETRY_CLASS = [
  "shrink-0 rounded-md border border-neutral-700 px-2.5 py-1 text-sm font-medium",
  "text-foreground transition hover:bg-neutral-800",
  // Colour first and unconditionally: `transition` covers `outline-color` too,
  // so a ring that gets its colour from the `focus-visible:` prefix fades in
  // from `currentColor` instead of arriving blue.
  "outline-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2"
].join(" ");

/** Stable keys, so the placeholders are not keyed by array index. */
const SKELETON_KEYS = ["a", "b", "c", "d"];

function RouteComponent() {
  const { session } = Route.useRouteContext();
  /**
   * The suspense flavour, so `data` cannot be `undefined` here: the loader has
   * already resolved this exact key, and the pending and failed phases belong to
   * the two components below. That leaves this component only the states that
   * are genuinely about data.
   *
   * The key is built from the session the client currently believes in, while
   * the server scopes the read from the cookie. They can only disagree after an
   * organization switch, and the rows on screen are the server's answer either
   * way.
   */
  const { data } = useSuspenseQuery(
    organizationProjectsQueryOptions(session.session.activeOrganizationId)
  );

  const navigate = useNavigate();
  const toast = Toast.useToastManager();
  const create = useCreateProject();

  /**
   * One press, no dialog: a new project is an empty canvas, and the point of
   * making one is to be on it. Naming waits until the studio, where the toolbar
   * already renames — which is also where the name is easiest to choose, once
   * there is something on the board to name.
   *
   * The failure has to be reported from here rather than from a form that is no
   * longer in the way, so it goes to the toast the canvas already uses for the
   * things it has to refuse.
   */
  function createAndOpen() {
    create.mutate(undefined, {
      onSuccess: (project) =>
        void navigate({ to: "/studio/$projectId", params: { projectId: project.id } }),
      onError: (error) =>
        toast.add({
          type: "error",
          title: "Could not create the project",
          // A failed server function can carry driver-level detail — a
          // connection string, a fragment of SQL — so only the development
          // build shows the original message, the same trade the dialogs make.
          description: import.meta.env.DEV ? error.message : "Please try again."
        })
    });
  }

  /**
   * Withheld when the session is not scoped to an organization, because that is
   * exactly the state the create would throw in. Nothing else on this page can
   * put it right — the switcher in the sidebar can — so an inert button here
   * would only be a dead end with a spinner.
   *
   * `pending` rather than `disabled` while the insert is in flight: the button
   * keeps focus, and Base UI swallows the click anyway, so a second press cannot
   * make a second project.
   */
  const newProjectButton = data.organization ? (
    <Button onClick={createAndOpen} pending={create.isPending}>
      New project
    </Button>
  ) : null;

  return (
    <div className={PAGE_CLASS}>
      <div className={CONTENT_CLASS}>
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className={TITLE_CLASS}>Projects</h1>
            <p className={SUBTITLE_CLASS}>
              {countLabel(data.projects.length, data.organization?.name ?? null)}
            </p>
          </div>
          {newProjectButton}
        </header>

        <div className="mt-8">
          {/* The same button again on an empty page, not a second way of doing
              it: with no cards to look at, the one in the corner is the only
              thing on screen and nothing points at it. */}
          <ProjectGrid data={data} action={newProjectButton} />
        </div>
      </div>
    </div>
  );
}

/** Split out so the three outcomes read as three cases rather than nested ternaries. */
function ProjectGrid({ data, action }: { data: OrganizationProjects; action: ReactNode }) {
  if (!data.organization) {
    return (
      <Panel
        icon="info"
        title="No active organization"
        description="This session is not scoped to an organization you belong to, so there is nothing to show yet."
      />
    );
  }

  if (data.projects.length === 0) {
    return (
      <Panel
        icon="folder_open"
        title="No projects yet"
        description={`Projects created in ${data.organization.name} will show up here.`}
        action={action}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* `role="list"` is not redundant: Tailwind's preflight sets
          `list-style: none` on every `ul`, and WebKit drops the list role when it
          sees that — which is exactly the announcement this markup is here for. */}
      <ul role="list" className={GRID_CLASS}>
        {data.projects.map((project) => (
          <li key={project.id}>
            <ProjectCard {...project} />
          </li>
        ))}
      </ul>
      {data.hasMore ? (
        <p className="text-xs text-neutral-500">
          Showing the {data.projects.length} most recently updated projects.
        </p>
      ) : null}
    </div>
  );
}

function Panel({
  icon,
  title,
  description,
  action
}: {
  icon: string;
  title: string;
  description: string;
  /** The way out of this state, for the panels that have one. */
  action?: ReactNode;
}) {
  return (
    <div className={PANEL_CLASS}>
      <span className={PANEL_ICON_CLASS}>
        <Icon name={icon} />
      </span>
      <h2 className="text-foreground text-base font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-neutral-400">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

function countLabel(count: number, organizationName: string | null) {
  const projects = `${count} ${count === 1 ? "project" : "projects"}`;

  return organizationName ? `${projects} in ${organizationName}` : projects;
}

/**
 * Only reached when a client navigation outruns the loader — the first paint is
 * served with data already resolved — so there is no server render of this to
 * disagree with.
 */
function ProjectsPending() {
  return (
    <div className={PAGE_CLASS}>
      <div className={CONTENT_CLASS}>
        <header className="min-w-0">
          <h1 className={TITLE_CLASS}>Projects</h1>
          <div className="mt-2 h-4 w-32 animate-pulse rounded bg-neutral-800" />
        </header>

        {/* The boxes are decorative; this line is what a screen reader gets. */}
        <p role="status" className="sr-only">
          Loading projects…
        </p>

        <ul aria-hidden={true} className={`${GRID_CLASS} mt-8`}>
          {SKELETON_KEYS.map((key) => (
            <li key={key}>
              <ProjectCardSkeleton />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ProjectsError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();

  // React Query caches the rejection as well. Without this reset, retrying would
  // replay the cached error instead of going back to the server.
  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  function retry() {
    reset();
    void router.invalidate();
  }

  return (
    <div className={PAGE_CLASS}>
      <div className={CONTENT_CLASS}>
        <header className="min-w-0">
          <h1 className={TITLE_CLASS}>Projects</h1>
        </header>

        <div role="alert" className={`${ERROR_CLASS} mt-8`}>
          <Icon name="error" className="text-2xl text-red-400" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-foreground text-sm font-medium">We could not load your projects.</p>
            {/* A failed server function can carry driver-level detail — a
                connection string, a fragment of SQL — so only the development
                build shows the original message. */}
            <p className="text-sm text-neutral-400">
              {import.meta.env.DEV ? error.message : "Something went wrong on our side."}
            </p>
          </div>
          <button type="button" onClick={retry} className={RETRY_CLASS}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
