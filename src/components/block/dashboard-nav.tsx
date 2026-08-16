import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import Icon from "#/components/ui/icon";
import { canManageMembers, myOrganizationsQueryOptions } from "#/lib/organizations";

/**
 * Where the sidebar can take you.
 *
 * Two groups at most: the projects, split into the list and its archive, and —
 * for an organization somebody owns and that has other people in it — the page
 * where those people are managed. The second group is absent rather than
 * disabled for a private workspace: a permanently greyed-out row is a promise
 * about a feature that will never apply there.
 *
 * The links collapse to their icons below `md`, where the sidebar itself
 * narrows to a strip. The group headings collapse away entirely — at that width
 * there is no room for a word that only labels other words, and the icons
 * carry it.
 */

const LINK_CLASS = [
  "flex h-9 shrink-0 items-center gap-2 rounded-2xl px-1.5 text-sm text-neutral-300",
  "transition-colors duration-100 select-none md:px-3",
  "hover:bg-[rgba(218,220,224,0.08)] hover:text-foreground",
  // Stated unconditionally, like every other focus ring in this app: the
  // transition above covers `outline-color`, and a colour that only arrives
  // with focus animates up from `currentColor` in full view.
  "outline-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2"
].join(" ");

/**
 * Applied through `activeProps`, which TanStack Router merges into the class
 * list rather than replacing it. The current page is filled rather than merely
 * brighter, because the row above it is the organization switcher wearing the
 * same fill for "menu open" — two different meanings for two different colours
 * would be worse than one meaning for one.
 */
const ACTIVE_CLASS = "bg-[rgba(218,220,224,0.08)] text-foreground";

const GROUP_LABEL_CLASS =
  "hidden px-3 pb-1 text-[11px] leading-4 font-medium text-neutral-500 md:block";

function NavIcon({ name }: { name: string }) {
  // Boxed to the width of the switcher's monogram above it, so every label in
  // the sidebar starts at the same edge.
  return (
    <span className="flex size-6 shrink-0 items-center justify-center">
      <Icon name={name} className="text-lg text-neutral-400" />
    </span>
  );
}

function NavLabel({ children }: { children: ReactNode }) {
  return <span className="hidden min-w-0 flex-1 truncate md:block">{children}</span>;
}

export default function DashboardNav() {
  // The same read the switcher above it suspends on, so this costs nothing
  // extra: one query answers which organizations exist, which one is active,
  // and what this user is allowed to do in it.
  const { data: organizations } = useSuspenseQuery(myOrganizationsQueryOptions());
  const active = organizations.find((organization) => organization.active);

  return (
    <nav aria-label="Main" className="mt-4 flex flex-col gap-4">
      <div>
        <p className={GROUP_LABEL_CLASS}>Projects</p>
        <div className="flex flex-col gap-0.5">
          {/*
           * `exact`, or the archive route below would light this one up too —
           * `/projects/archive` starts with `/projects`, and the default match
           * is by prefix.
           */}
          <Link
            to="/projects"
            activeOptions={{ exact: true }}
            activeProps={{ className: ACTIVE_CLASS }}
            className={LINK_CLASS}
          >
            <NavIcon name="grid_view" />
            <NavLabel>All</NavLabel>
          </Link>
          <Link
            to="/projects/archive"
            activeProps={{ className: ACTIVE_CLASS }}
            className={LINK_CLASS}
          >
            <NavIcon name="archive" />
            <NavLabel>Archive</NavLabel>
          </Link>
        </div>
      </div>

      {canManageMembers(active) ? (
        <div>
          <p className={GROUP_LABEL_CLASS}>Organization</p>
          <div className="flex flex-col gap-0.5">
            <Link
              to="/organization/members"
              activeProps={{ className: ACTIVE_CLASS }}
              className={LINK_CLASS}
            >
              <NavIcon name="group" />
              <NavLabel>Members</NavLabel>
            </Link>
          </div>
        </div>
      ) : null}

      {/*
       * Unconditional, unlike the group above it. The profile is the account
       * rather than the workspace, and the wallet — though it belongs to the
       * organization — has to show its balance to every member, because that is
       * the number behind every "not enough credits" they can hit. Credits is
       * also the page somebody arrives at *because* something was refused,
       * which is a reason for it to be reachable from everywhere rather than
       * only from the error.
       */}
      <div>
        <p className={GROUP_LABEL_CLASS}>Account</p>
        <div className="flex flex-col gap-0.5">
          <Link to="/account" activeProps={{ className: ACTIVE_CLASS }} className={LINK_CLASS}>
            <NavIcon name="person" />
            <NavLabel>Profile</NavLabel>
          </Link>
          <Link to="/billing" activeProps={{ className: ACTIVE_CLASS }} className={LINK_CLASS}>
            <NavIcon name="account_balance_wallet" />
            <NavLabel>Credits</NavLabel>
          </Link>
        </div>
      </div>
    </nav>
  );
}
