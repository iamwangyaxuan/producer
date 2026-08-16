import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { DashboardPage, INPUT_CLASS, SECTION_TITLE_CLASS } from "#/components/block/dashboard-page";
import { ConfirmDialog } from "#/components/block/project-dialogs";
import Avatar from "#/components/ui/avatar";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import {
  EMAIL_MAX_LENGTH,
  organizationMembersQueryOptions,
  useCancelInvitation,
  useInviteMember,
  useRemoveMember
} from "#/lib/members";
import type { OrganizationMember, PendingInvitation } from "#/lib/members";

/**
 * Who is in this organization, and the two ways that changes.
 *
 * Reachable only for a `team` or `enterprise` organization whose owner is
 * reading it — the sidebar hides the link otherwise, and `fetchOrganizationMembers`
 * refuses the read as well, because a hidden link is not a permission. A
 * private workspace is one person by definition, so there is nothing here for
 * it to show.
 */
export const Route = createFileRoute("/_auth/_dashboard/organization/members")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(
      organizationMembersQueryOptions(context.session.session.activeOrganizationId)
    );
  },
  component: RouteComponent
});

const ROW_CLASS =
  "flex items-center gap-3 rounded-[12px] border border-[rgba(218,220,224,0.08)] px-3 py-2.5";

function RouteComponent() {
  const { session } = Route.useRouteContext();
  const { data } = useSuspenseQuery(
    organizationMembersQueryOptions(session.session.activeOrganizationId)
  );

  const invite = useInviteMember();
  const cancelInvitation = useCancelInvitation();
  const removeMember = useRemoveMember();

  const [email, setEmail] = useState("");
  const [removing, setRemoving] = useState<OrganizationMember | null>(null);
  /**
   * Kept separately from `removing`, and deliberately not cleared with it.
   *
   * The dialog animates out over 150ms, during which it is still mounted and
   * still rendering its description — so reading the name off a `removing` that
   * the success handler has already set to `null` put the word "undefined" on
   * screen for the length of the exit. Holding the last name means the sentence
   * stays intact while the dialog leaves.
   */
  const [removingName, setRemovingName] = useState("");
  const emailId = useId();

  function askToRemove(member: OrganizationMember) {
    // The hook outlives the dialog, so a previous failure would otherwise still
    // be showing the next time one is opened.
    removeMember.reset();
    setRemoving(member);
    setRemovingName(member.name.trim() || member.email);
  }

  if (!data.organization) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-neutral-800 px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-neutral-800 text-2xl text-neutral-400">
            <Icon name="group" />
          </span>
          <h2 className="text-foreground text-base font-medium">Nothing to manage here</h2>
          <p className="max-w-sm text-sm text-neutral-400">
            Members are managed by the owner of a team or enterprise organization. Switch to one you
            own to invite people.
          </p>
        </div>
      </Shell>
    );
  }

  const { organization, members, invitations } = data;
  // The ceiling is what was paid for; the tally is what is in `member`. A
  // pending invitation has not taken a seat yet — the check runs when it is
  // accepted — so it is counted separately rather than folded in here.
  const seatsLeft = organization.seat - members.length;

  function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Normalized here as well as server-side: better-auth lowercases before it
    // stores, and matching that locally is what stops "Foo@bar.com" from
    // looking like a different address than the row it will collide with.
    const address = email.trim().toLowerCase();
    if (!address || invite.isPending) return;

    invite.mutate({ email: address }, { onSuccess: () => setEmail("") });
  }

  return (
    <Shell name={organization.name}>
      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className={SECTION_TITLE_CLASS}>Invite someone</h2>
          <p className="text-xs text-neutral-500">
            {members.length} of {organization.seat} seats used
          </p>
        </div>

        {/* The refusal is stated before the attempt rather than after it: the
            seat check that would reject this runs when the invitation is
            *accepted*, which is a long way from the person pressing the button
            here. */}
        {seatsLeft <= 0 ? (
          <p className="mt-2 text-xs text-neutral-400">
            Every seat on this plan is taken. Remove someone to free one up.
          </p>
        ) : null}

        <form onSubmit={submitInvite} className="mt-3 flex flex-wrap items-start gap-2">
          <div className="min-w-56 flex-1">
            <label htmlFor={emailId} className="sr-only">
              Email address
            </label>
            <input
              id={emailId}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={EMAIL_MAX_LENGTH}
              placeholder="teammate@example.com"
              disabled={invite.isPending}
              required
              className={INPUT_CLASS}
            />
          </div>
          {/* `pending` rather than `disabled` while the mail is going out: the
              button keeps focus and Base UI swallows the click anyway. */}
          <Button type="submit" size="lg" pending={invite.isPending} disabled={email.trim() === ""}>
            Send invitation
          </Button>
        </form>

        <ActionError error={invite.error} />
      </section>

      <section className="mt-8">
        <h2 className={SECTION_TITLE_CLASS}>
          Members <span className="text-neutral-500">({members.length})</span>
        </h2>
        <ul role="list" className="mt-3 flex flex-col gap-2">
          {members.map((member) => (
            <li key={member.id} className={ROW_CLASS}>
              <Avatar decorative name={member.name.trim() || member.email} src={member.image} />
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm">
                  {member.name.trim() || member.email}
                </p>
                <p className="truncate text-xs text-neutral-500">{member.email}</p>
              </div>
              <RoleTag role={member.role} />
              {/*
               * No remove button against the owner or against the person
               * reading the page. Removing the owner would leave the
               * organization with a `ownerId` pointing at a non-member, and
               * removing yourself here is a different action with different
               * consequences — better-auth has `leave` for that.
               */}
              {member.role === "owner" || member.userId === data.viewerUserId ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${member.name.trim() || member.email}`}
                  onClick={() => askToRemove(member)}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {invitations.length > 0 ? (
        <section className="mt-8">
          <h2 className={SECTION_TITLE_CLASS}>
            Pending invitations <span className="text-neutral-500">({invitations.length})</span>
          </h2>
          <ul role="list" className="mt-3 flex flex-col gap-2">
            {invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                onCancel={() => cancelInvitation.mutate({ invitationId: invitation.id })}
                pending={cancelInvitation.isPending}
              />
            ))}
          </ul>
          <ActionError error={cancelInvitation.error} />
        </section>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove member?"
        description={`${removingName} will lose access to everything in ${organization.name}. Their seat frees up immediately.`}
        confirmLabel="Remove"
        destructive
        // Inside the dialog rather than under the list, because the dialog
        // stays open on failure — an error printed behind it would be reporting
        // to a page nobody is looking at.
        error={removeMember.error}
        pending={removeMember.isPending}
        onConfirm={() => {
          if (!removing) return;

          removeMember.mutate({ memberId: removing.id }, { onSuccess: () => setRemoving(null) });
        }}
      />
    </Shell>
  );
}

function Shell({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <DashboardPage width="narrow" title="Members" description={name}>
      {children}
    </DashboardPage>
  );
}

/** Greyscale, like everything else that is a label rather than an interaction. */
function RoleTag({ role }: { role: string }) {
  return (
    <span className="shrink-0 rounded-md bg-[rgba(218,220,224,0.08)] px-2 py-0.5 text-[11px] leading-4 text-neutral-300 capitalize">
      {role}
    </span>
  );
}

const EXPIRY_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function InvitationRow({
  invitation,
  onCancel,
  pending
}: {
  invitation: PendingInvitation;
  onCancel: () => void;
  pending: boolean;
}) {
  const [copied, setCopied] = useState(false);

  /**
   * The fallback for an email that never arrived. Safe to hand around: the id
   * on its own is not a key — accepting re-checks that the signed-in address is
   * the one that was invited, so a link in the wrong hands opens a page that
   * refuses.
   *
   * Built in the browser rather than on the server so it carries whatever
   * origin this tab is actually on, which is the one the recipient will be able
   * to reach.
   */
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/accept-invitation/${invitation.id}`
      );
      setCopied(true);
      // Long enough to read, short enough that the button is ready again before
      // anyone wants to copy a second one.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused outright (permissions, an insecure
      // origin). Nothing is broken and there is nothing to retry, so the label
      // simply does not change.
    }
  }

  return (
    <li className={ROW_CLASS}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[rgba(218,220,224,0.08)]">
        <Icon name="mail" className="text-sm text-neutral-400" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm">{invitation.email}</p>
        <p className="truncate text-xs text-neutral-500">
          Expires {EXPIRY_FORMAT.format(invitation.expiresAt)}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={copyLink}>
        {copied ? "Copied" : "Copy link"}
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel} pending={pending}>
        Cancel
      </Button>
    </li>
  );
}

/**
 * These messages come from better-auth rather than from a server function, so
 * they are already written for a person — "This organization has no seats left
 * (12 in total)" is the seat check in `auth.ts` talking. Nothing here can carry
 * driver-level detail, which is why it is shown as-is rather than hidden behind
 * `import.meta.env.DEV` like the project dialogs do.
 */
function ActionError({ error }: { error: Error | null }) {
  if (!error) return null;

  return (
    <p role="alert" className="mt-3 text-sm text-red-400">
      {error.message}
    </p>
  );
}
