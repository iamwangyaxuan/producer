import { useQueryErrorResetBoundary, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import {
  CARD_CLASS,
  DashboardPage,
  INPUT_CLASS,
  PageCard,
  PageErrorPanel,
  SECTION_TITLE_CLASS
} from "#/components/block/dashboard-page";
import Avatar from "#/components/ui/avatar";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import {
  profileQueryOptions,
  useChangePassword,
  useRevokeOtherSessions,
  useSetInitialPassword,
  useUpdateName
} from "#/lib/profile";
import type { ProfileSummary } from "#/lib/profile";

/*
 * The account, as opposed to the workspace.
 *
 * The only page under `_dashboard` that ignores the organization switcher above
 * it: your name, your password and your devices are the same whichever
 * workspace you happen to be looking at. Everything organization-shaped —
 * members, credits — lives on its own pages, and keeping them apart is what
 * stops this one from becoming a settings drawer for everything.
 */

const LABEL_CLASS = "text-xs text-neutral-400";

const ROW_CLASS = "flex items-baseline justify-between gap-4 py-2 text-sm";

/** Shortest password better-auth is configured to take; stated, not implied. */
const MIN_PASSWORD = 8;

const JOINED_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "long" });

export function ProfilePage() {
  const { data: profile } = useSuspenseQuery(profileQueryOptions());

  if (!profile) {
    // Only reachable if the session went away between the guard and this read.
    return (
      <DashboardPage width="narrow" title="Profile">
        <p className="mt-4 text-sm text-neutral-400">You are no longer signed in.</p>
      </DashboardPage>
    );
  }

  return (
    <DashboardPage
      width="narrow"
      title="Profile"
      description="Your account — the same on every workspace you belong to."
    >
      <IdentityCard profile={profile} />
      <PasswordCard hasPassword={profile.hasPassword} />
      <DevicesCard sessionCount={profile.sessionCount} />
    </DashboardPage>
  );
}

/**
 * Who you are: the picture, the name you can change, and the address you
 * cannot.
 *
 * The email is shown and not editable. Changing it is a different feature with
 * a different shape — it has to be proved before it takes effect, or an account
 * could be moved to an address its owner does not read — and a field that looks
 * editable and is not would be worse than a line of text.
 */
function IdentityCard({ profile }: { profile: ProfileSummary }) {
  const nameId = useId();
  const [name, setName] = useState(profile.name);

  const update = useUpdateName();

  const trimmed = name.trim();
  // Nothing to save when it is unchanged or empty. Empty is refused rather than
  // stored because every screen falls back to the address when a name is blank,
  // so saving one would look like it had not saved at all.
  const dirty = trimmed !== "" && trimmed !== profile.name;

  return (
    <PageCard className="mt-6">
      <div className="flex items-center gap-3">
        <Avatar decorative name={profile.name.trim() || profile.email} src={profile.image} />
        <div className="min-w-0">
          <p className="text-foreground truncate text-base font-medium">
            {profile.name.trim() || profile.email}
          </p>
          <p className="truncate text-sm text-neutral-400">{profile.email}</p>
        </div>
      </div>

      <div className="mt-5">
        <label htmlFor={nameId} className={LABEL_CLASS}>
          Display name
        </label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            disabled={update.isPending}
            className={`${INPUT_CLASS} min-w-0 flex-1`}
          />
          <Button
            onClick={() => update.mutate({ name: trimmed })}
            disabled={!dirty}
            pending={update.isPending}
          >
            Save
          </Button>
        </div>
        {update.error ? (
          <p role="alert" className="mt-1.5 text-sm text-red-400">
            {update.error.message}
          </p>
        ) : null}
      </div>

      <dl className="mt-5 divide-y divide-[rgba(218,220,224,0.08)]">
        <div className={ROW_CLASS}>
          <dt className="text-neutral-400">Email</dt>
          <dd className="flex items-center gap-1.5">
            {profile.emailVerified ? (
              <>
                <Icon name="verified" className="text-sm text-neutral-400" />
                <span className="text-neutral-300">Verified</span>
              </>
            ) : (
              // Worth saying plainly: an unverified address cannot accept an
              // organization invitation, which is the one thing somebody would
              // otherwise find out only when it failed.
              <span className="text-amber-400">
                Not verified — sign in with an emailed code to confirm it
              </span>
            )}
          </dd>
        </div>
        <Row
          label="Sign in with"
          value={
            profile.signInMethods.length > 0
              ? profile.signInMethods.join(", ")
              : // Every account can always use a code or a link, so "none" here
                // means "no stored credential", not "no way in".
                "An emailed code or link"
          }
        />
        <Row label="Joined" value={JOINED_FORMAT.format(new Date(profile.createdAt))} />
      </dl>
    </PageCard>
  );
}

/**
 * The password, in whichever of its two forms applies.
 *
 * An account made through Google or an emailed code has none at all, and until
 * now had no way to get one — so this is a "set" form there and a "change" form
 * everywhere else. They are one component because they differ only in whether
 * the old password is asked for, and two would drift on the rules below them.
 */
function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const currentId = useId();
  const nextId = useId();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);

  const change = useChangePassword();
  const set = useSetInitialPassword();

  const pending = change.isPending || set.isPending;
  const error = change.error ?? set.error;
  const ready = next.length >= MIN_PASSWORD && (!hasPassword || current !== "");

  function clear() {
    setCurrent("");
    setNext("");
    setDone(true);
  }

  function submit() {
    if (!ready) return;

    setDone(false);

    if (hasPassword)
      change.mutate({ currentPassword: current, newPassword: next }, { onSuccess: clear });
    else set.mutate({ newPassword: next }, { onSuccess: clear });
  }

  return (
    <PageCard className="mt-4">
      <p className={SECTION_TITLE_CLASS}>{hasPassword ? "Change password" : "Set a password"}</p>
      <p className="mt-1 text-xs text-neutral-400">
        {hasPassword
          ? "Changing it signs you out on every other device."
          : "You sign in without one today. Setting one adds a way in — it does not take the others away."}
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {hasPassword ? (
          <div>
            <label htmlFor={currentId} className={LABEL_CLASS}>
              Current password
            </label>
            <input
              id={currentId}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              disabled={pending}
              className={`${INPUT_CLASS} mt-1.5`}
            />
          </div>
        ) : null}

        <div>
          <label htmlFor={nextId} className={LABEL_CLASS}>
            New password
          </label>
          <input
            id={nextId}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            disabled={pending}
            className={`${INPUT_CLASS} mt-1.5`}
          />
          <p className="mt-1.5 text-xs text-neutral-500">At least {MIN_PASSWORD} characters.</p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error.message}
        </p>
      ) : null}

      {done && !error ? (
        <p role="status" className="mt-3 text-sm text-neutral-300">
          Password saved.
        </p>
      ) : null}

      <Button onClick={submit} disabled={!ready} pending={pending} className="mt-4">
        {hasPassword ? "Change password" : "Set password"}
      </Button>
    </PageCard>
  );
}

/**
 * Where else you are signed in.
 *
 * A count and one button rather than a list of devices: better-auth records a
 * user agent and an IP, and both are guesses about a machine that a person
 * cannot reliably match to a device in their hand. "Somewhere I do not
 * recognise" is answered by the button either way.
 */
function DevicesCard({ sessionCount }: { sessionCount: number }) {
  const revoke = useRevokeOtherSessions();
  const others = Math.max(0, sessionCount - 1);

  return (
    <PageCard className="mt-4">
      <p className={SECTION_TITLE_CLASS}>Signed-in devices</p>
      <p className="mt-1 text-xs text-neutral-400">
        {others === 0
          ? "This is the only device signed in to your account."
          : `This device, and ${others} other ${others === 1 ? "session" : "sessions"}.`}
      </p>

      {revoke.error ? (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {revoke.error.message}
        </p>
      ) : null}

      <Button
        variant="secondary"
        onClick={() => revoke.mutate()}
        disabled={others === 0}
        pending={revoke.isPending}
        className="mt-4"
      >
        Sign out everywhere else
      </Button>
    </PageCard>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={ROW_CLASS}>
      <dt className="text-neutral-400">{label}</dt>
      <dd className="text-foreground min-w-0 truncate">{value}</dd>
    </div>
  );
}

export function ProfilePagePending() {
  return (
    <DashboardPage width="narrow" title="Profile">
      <p role="status" className="sr-only">
        Loading your profile…
      </p>
      <div aria-hidden={true} className="mt-6 flex flex-col gap-4">
        <div className={`${CARD_CLASS} h-56 animate-pulse`} />
        <div className={`${CARD_CLASS} h-44 animate-pulse`} />
      </div>
    </DashboardPage>
  );
}

export function ProfilePageError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();

  // The rejection is cached too; without this reset, retrying replays it.
  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  return (
    <DashboardPage width="narrow" title="Profile">
      <PageErrorPanel
        title="We could not load your profile."
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </DashboardPage>
  );
}
