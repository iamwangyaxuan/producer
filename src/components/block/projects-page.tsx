import { Toast } from "@base-ui/react/toast";
import { useQueryErrorResetBoundary, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { DashboardPage, PageErrorPanel } from "#/components/block/dashboard-page";
import ProjectCard, { ProjectCardSkeleton } from "#/components/block/project-card";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import { organizationProjectsQueryOptions, useCreateProject } from "#/lib/projects";
import type { OrganizationProjects } from "#/lib/projects";

/*
 * Both project lists, as one page told which half it is.
 *
 * They are the same grid over the same read with `archived` flipped, so the
 * alternative was two files that had to be kept agreeing about their skeletons,
 * their error screen, their empty state and their column counts. What actually
 * differs is small enough to sit in `COPY` below — and keeping it there is what
 * makes the differences legible as a list instead of as a diff between files.
 */

const GRID_CLASS =
  "grid grid-cols-1 gap-4 @lg:grid-cols-2 @3xl:grid-cols-3 @3xl:gap-6 @5xl:grid-cols-4";

const PANEL_CLASS =
  "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-800 px-6 py-16 text-center";

const PANEL_ICON_CLASS =
  "flex size-12 items-center justify-center rounded-full bg-neutral-800 text-2xl text-neutral-400";

/** Stable keys, so the placeholders are not keyed by array index. */
const SKELETON_KEYS = ["a", "b", "c", "d"];

/** Everything that differs between the two views, in one place to compare. */
const COPY = {
  active: {
    title: "Projects",
    noun: (count: number) => `${count} ${count === 1 ? "project" : "projects"}`,
    emptyIcon: "folder_open",
    emptyTitle: "No projects yet",
    emptyBody: (organization: string) => `Projects created in ${organization} will show up here.`
  },
  archived: {
    title: "Archive",
    noun: (count: number) => `${count} archived ${count === 1 ? "project" : "projects"}`,
    emptyIcon: "archive",
    emptyTitle: "Nothing archived",
    emptyBody: (organization: string) =>
      `Projects you archive in ${organization} will show up here, and can be restored from it.`
  }
} as const;

function copyFor(archived: boolean) {
  return archived ? COPY.archived : COPY.active;
}

export interface ProjectsPageProps {
  archived: boolean;
  /**
   * The organization the *client* currently believes in — it keys the cache and
   * never travels to the server, which scopes the read from the cookie. They
   * can only disagree after an organization switch, and the rows on screen are
   * the server's answer either way.
   */
  activeOrganizationId: string | null | undefined;
}

export function ProjectsPage({ archived, activeOrganizationId }: ProjectsPageProps) {
  /**
   * The suspense flavour, so `data` cannot be `undefined` here: the loader has
   * already resolved this exact key, and the pending and failed phases belong to
   * the two components below. That leaves this component only the states that
   * are genuinely about data.
   */
  const { data } = useSuspenseQuery(
    organizationProjectsQueryOptions(activeOrganizationId, archived)
  );

  const navigate = useNavigate();
  const toast = Toast.useToastManager();
  const create = useCreateProject();
  const copy = copyFor(archived);

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
   * Withheld from the archive, where "new project" would create something that
   * does not belong to the list you are looking at, and withheld when the
   * session is not scoped to an organization, because that is exactly the state
   * the create would throw in. Nothing on this page can put that right — the
   * switcher in the sidebar can — so an inert button here would only be a dead
   * end with a spinner.
   *
   * `pending` rather than `disabled` while the insert is in flight: the button
   * keeps focus, and Base UI swallows the click anyway, so a second press cannot
   * make a second project.
   */
  const newProjectButton =
    data.organization && !archived ? (
      <Button onClick={createAndOpen} pending={create.isPending}>
        New project
      </Button>
    ) : null;

  return (
    <DashboardPage
      width="wide"
      title={copy.title}
      description={countLabel(data.projects.length, data.organization?.name ?? null, archived)}
      actions={newProjectButton}
    >
      <div className="mt-8">
        {/* The same button again on an empty page, not a second way of doing
            it: with no cards to look at, the one in the corner is the only
            thing on screen and nothing points at it. */}
        <ProjectGrid data={data} archived={archived} action={newProjectButton} />
      </div>
    </DashboardPage>
  );
}

/** Split out so the three outcomes read as three cases rather than nested ternaries. */
function ProjectGrid({
  data,
  archived,
  action
}: {
  data: OrganizationProjects;
  archived: boolean;
  action: ReactNode;
}) {
  const copy = copyFor(archived);

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
        icon={copy.emptyIcon}
        title={copy.emptyTitle}
        description={copy.emptyBody(data.organization.name)}
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
            <ProjectCard {...project} archived={archived} />
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

function countLabel(count: number, organizationName: string | null, archived: boolean) {
  const projects = copyFor(archived).noun(count);

  return organizationName ? `${projects} in ${organizationName}` : projects;
}

/**
 * Only reached when a client navigation outruns the loader — the first paint is
 * served with data already resolved — so there is no server render of this to
 * disagree with.
 */
export function ProjectsPagePending({ archived }: { archived: boolean }) {
  const copy = copyFor(archived);

  return (
    <DashboardPage
      width="wide"
      title={copy.title}
      // A bar where the count will be, so the heading does not jump down a line
      // when the real one arrives.
      description={<span className="block h-4 w-32 animate-pulse rounded bg-neutral-800" />}
    >
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
    </DashboardPage>
  );
}

export function ProjectsPageError({
  archived,
  error,
  reset
}: ErrorComponentProps & { archived: boolean }) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();

  // React Query caches the rejection as well. Without this reset, retrying would
  // replay the cached error instead of going back to the server.
  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  return (
    <DashboardPage width="wide" title={copyFor(archived).title}>
      <PageErrorPanel
        title="We could not load your projects."
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </DashboardPage>
  );
}
