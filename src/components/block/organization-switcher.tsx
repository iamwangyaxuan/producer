import { useSuspenseQuery } from "@tanstack/react-query";

import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";
import { myOrganizationsQueryOptions, useSwitchOrganization } from "#/lib/organizations";
import type { OrganizationMembership } from "#/lib/organizations";

/**
 * The popup opens downwards from the head of the sidebar — the mirror image of
 * the account menu at its foot.
 */
const POPUP_POSITIONER = { side: "bottom", align: "start", sideOffset: 8 } as const;

/** Lit while its menu is open, matching what the menu rows themselves do. */
const TRIGGER_CLASS = "data-popup-open:bg-[rgba(218,220,224,0.08)]";

/**
 * Which organization the dashboard is looking at, and the way to point it at
 * another one.
 *
 * This is the control the projects grid quietly depends on: the list only ever
 * shows the *active* organization's projects, so someone invited into a second
 * organization sees none of its work until the session is re-scoped — which is
 * exactly what a row in this menu does, through better-auth's own endpoint.
 *
 * It sits at the head of the sidebar, where every multi-workspace tool keeps
 * it; like the account menu below it, the name collapses away on narrow
 * screens while the monogram stays.
 */
export default function OrganizationSwitcher() {
  const { data: organizations } = useSuspenseQuery(myOrganizationsQueryOptions());
  const switchOrganization = useSwitchOrganization();

  // No session, or a user somehow stripped of every membership: there is
  // nothing to show and nothing to switch to.
  if (organizations.length === 0) return null;

  const active = organizations.find((organization) => organization.active);

  // The name the session is scoped to — or an invitation to pick one, for a
  // session whose snapshot points at an organization this user has left.
  const label = active?.name ?? "Select organization";

  function choose(organization: OrganizationMembership) {
    // Re-selecting the current one is a no-op, not a round trip.
    if (organization.active || switchOrganization.isPending) return;

    switchOrganization.mutate({ organizationId: organization.id });
  }

  return (
    <Menu.Root>
      {/* The label carries the visible name rather than replacing it, so a
          voice-control user can still say what they can read — and the button
          keeps an accessible name at the width where only the monogram shows. */}
      <Menu.Trigger
        aria-label={`Organization: ${label}`}
        render={
          <Button
            variant="ghost"
            size="lg"
            pending={switchOrganization.isPending}
            className={`w-full justify-start px-1.5 md:px-3 ${TRIGGER_CLASS}`}
          />
        }
      >
        <Monogram name={label} />
        {/* `min-w-0` is what lets the truncation happen at all: a flex child
            refuses to shrink below its content without it. */}
        <span className="hidden min-w-0 flex-1 truncate text-left md:block">{label}</span>
        <Icon name="unfold_more" className="hidden text-base text-neutral-400 md:block" />
      </Menu.Trigger>

      <Menu.Content positioner={POPUP_POSITIONER}>
        <Menu.Group>
          <Menu.GroupLabel>Organizations</Menu.GroupLabel>
          {organizations.map((organization) => (
            <Menu.Item
              key={organization.id}
              disabled={switchOrganization.isPending}
              onClick={() => choose(organization)}
            >
              <Monogram name={organization.name} />
              <span className="max-w-56 min-w-0 flex-1 truncate">{organization.name}</span>
              {/* The mark says "you are here", so it belongs to exactly one row.
                  Kept in the layout for the others as a spacer would be, so
                  names all start at the same edge and nothing shifts on switch. */}
              <Icon
                name="check"
                className={`text-base ${organization.active ? "text-foreground" : "invisible"}`}
              />
            </Menu.Item>
          ))}
        </Menu.Group>

        {switchOrganization.error ? (
          <p role="alert" className="max-w-64 px-3 pt-1 pb-2 text-xs text-red-400">
            {switchOrganization.error.message}
          </p>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * Organizations have no image column yet, so every one gets a monogram — the
 * first grapheme rather than the first byte, so 王雅萱 gets 王 and not a broken
 * glyph.
 */
function Monogram({ name }: { name: string }) {
  const first = [...name.trim()][0]?.toUpperCase() ?? "?";

  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[rgba(218,220,224,0.12)] text-xs leading-none font-semibold text-neutral-200"
    >
      {first}
    </span>
  );
}
