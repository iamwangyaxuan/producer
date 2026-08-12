import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import Menu from "#/components/ui/menu";
import { useSignOut } from "#/lib/session";

export interface AccountMenuProps {
  /** Straight off the session the `_auth` guard has already resolved. */
  user: { name: string; email: string; image?: string | null };
}

/**
 * The popup opens upwards: the trigger is at the foot of the sidebar, and Base
 * UI would otherwise flip it there only after finding no room below.
 */
const POPUP_POSITIONER = { side: "top", align: "start", sideOffset: 8 } as const;

/** Lit while its menu is open, matching what the menu rows themselves do. */
const TRIGGER_CLASS = "data-popup-open:bg-[rgba(218,220,224,0.08)]";

/**
 * Who is signed in, and the one action that ends it.
 *
 * The name collapses away below `md` while the avatar stays, because the
 * sidebar itself narrows to a strip there — a face is still recognisable at
 * that width, a truncated name is not.
 */
export default function AccountMenu({ user }: AccountMenuProps) {
  const signOut = useSignOut();

  // `name` is NOT NULL but nothing stops it being whitespace, and the address is
  // the one thing every account has.
  const displayName = user.name.trim() || user.email;

  return (
    <Menu.Root>
      {/* The label carries the visible name rather than replacing it, so a
          voice-control user can still say what they can read — and the button
          keeps an accessible name at the width where only the avatar shows. */}
      <Menu.Trigger
        aria-label={`Account: ${displayName}`}
        render={
          <Button
            variant="ghost"
            size="lg"
            className={`w-full justify-start px-1.5 md:px-3 ${TRIGGER_CLASS}`}
          />
        }
      >
        <Avatar user={user} />
        {/* `min-w-0` is what lets the truncation happen at all: a flex child
            refuses to shrink below its content without it. */}
        <span className="hidden min-w-0 flex-1 truncate text-left md:block">{displayName}</span>
        <Icon name="expand_more" className="hidden text-base text-neutral-400 md:block" />
      </Menu.Trigger>

      <Menu.Content positioner={POPUP_POSITIONER}>
        {/*
         * A group rather than a loose label above a loose row: `GroupLabel`
         * requires one — Base UI throws without the context — and it is the
         * right shape anyway, because the address is what the row underneath
         * acts on. A screen reader announces the two together.
         */}
        <Menu.Group>
          {/* Which account this is, spelled out: the trigger shows a name, and
              two accounts can share one. `break-all` rather than truncation,
              because an address that has been cut short cannot be checked —
              which is the only reason it is here. */}
          <Menu.GroupLabel className="max-w-64 break-all">{user.email}</Menu.GroupLabel>
          {/*
           * `closeOnClick={false}` so the row survives its own click: the request
           * takes a moment, and this is where both the pending state and a
           * failure are shown. On success the navigation unmounts the whole
           * sidebar, which takes the menu with it.
           */}
          <Menu.Item
            closeOnClick={false}
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {signOut.isPending ? (
              <Icon name="progress_activity" className="animate-spin text-sm" />
            ) : (
              <Icon name="logout" className="text-sm" />
            )}
            {signOut.isPending ? "Signing out…" : "Sign out"}
          </Menu.Item>
        </Menu.Group>
        {signOut.error ? (
          <p role="alert" className="max-w-64 px-2 py-1.5 text-[11px] leading-4 text-red-400">
            {signOut.error.message}
          </p>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}

/**
 * Decorative: the button beside it is already labelled with the name this stands
 * for, so announcing it again would only be noise.
 */
function Avatar({ user }: AccountMenuProps) {
  return (
    <span
      aria-hidden={true}
      className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[rgba(218,220,224,0.16)] text-[10px] leading-none font-semibold text-neutral-200"
    >
      {user.image ? (
        <img
          src={user.image}
          alt=""
          // Google avatar URLs refuse requests that name another site as the
          // referrer, and a broken face is worse than none.
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      ) : (
        initial(user.name.trim() || user.email)
      )}
    </span>
  );
}

/** The first grapheme rather than the first byte, so 王雅萱 gets 王 and not a broken glyph. */
function initial(name: string) {
  return [...name][0]?.toUpperCase() ?? "?";
}
