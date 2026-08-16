import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import {
  invitationQueryOptions,
  useAcceptInvitation,
  useDeclineInvitation,
  useSendVerificationEmail
} from "#/lib/invitations";
import { useSignOut } from "#/lib/session";

/**
 * Where an invitation email lands.
 *
 * Under `_auth` but outside `_dashboard`: a sidebar full of the workspace you
 * are already in is not the context for a decision about joining a different
 * one, and the person arriving here may have signed up two seconds ago. Signing
 * in first is the `_auth` guard's job — it bounces to `/login` with this URL as
 * the redirect, so the link survives the detour.
 *
 * Every refusal is answered with something to do about it, which is the whole
 * reason `fetchInvitation` returns a state rather than a boolean: signed in as
 * the wrong person, an unverified address, and a full organization each have a
 * different way out, and "you cannot accept this" would have hidden all three.
 */
export const Route = createFileRoute("/_auth/accept-invitation/$invitationId")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(invitationQueryOptions(params.invitationId));
  },
  component: RouteComponent
});

const PAGE_CLASS = "flex min-h-screen items-center justify-center px-4 py-10";

const CARD_CLASS =
  "w-full max-w-md rounded-[18px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.03)] p-6 text-center";

const TITLE_CLASS = "text-foreground text-xl font-semibold tracking-tight";

const BODY_CLASS = "mt-2 text-sm text-neutral-400";

function RouteComponent() {
  const { invitationId } = Route.useParams();
  const { data: invitation } = useSuspenseQuery(invitationQueryOptions(invitationId));

  const navigate = useNavigate();
  const accept = useAcceptInvitation();
  const decline = useDeclineInvitation();
  const verify = useSendVerificationEmail();
  const signOut = useSignOut();

  if (invitation.state === "unavailable") {
    return (
      <Card icon="link_off" title="This invitation is no longer valid">
        <p className={BODY_CLASS}>
          It may have expired, been revoked, or already been used. Ask whoever invited you to send a
          new one.
        </p>
        <GoToProjects />
      </Card>
    );
  }

  if (invitation.state === "wrong-account") {
    return (
      <Card icon="person_off" title="This invitation is for someone else">
        <p className={BODY_CLASS}>
          It was sent to <strong className="text-foreground">{invitation.invitedEmail}</strong>, and
          you are signed in as {invitation.viewerEmail}. Sign out and back in with the invited
          address to accept it.
        </p>
        {/* The action that actually resolves this, rather than an instruction
            to go and find it. Signing out lands on `/login`, which is where
            the other account is waiting. */}
        <div className="mt-5 flex justify-center gap-2">
          <GoToProjects variant="ghost" />
          <Button onClick={() => signOut.mutate()} pending={signOut.isPending}>
            Sign out
          </Button>
        </div>
        <ActionError error={signOut.error} />
      </Card>
    );
  }

  if (invitation.state === "unverified") {
    return (
      <Card icon="mark_email_unread" title="Confirm your email first">
        <p className={BODY_CLASS}>
          Before joining {invitation.organizationName}, confirm that {invitation.viewerEmail} is
          your address. We will send a link — following it brings you straight back here.
        </p>
        <div className="mt-5 flex justify-center">
          <Button
            onClick={() =>
              verify.mutate({
                email: invitation.viewerEmail,
                callbackURL: `/accept-invitation/${invitationId}`
              })
            }
            pending={verify.isPending}
            disabled={verify.isSuccess}
          >
            {verify.isSuccess ? "Email sent" : "Send verification email"}
          </Button>
        </div>
        {verify.isSuccess ? (
          <p className="mt-3 text-xs text-neutral-500">
            Check {invitation.viewerEmail}. You can close this page and come back through the link.
          </p>
        ) : null}
        <ActionError error={verify.error} />
      </Card>
    );
  }

  if (invitation.state === "full") {
    return (
      <Card icon="event_busy" title={`${invitation.organizationName} is full`}>
        <p className={BODY_CLASS}>
          Every seat on its plan is taken, so there is nowhere to put you yet. The invitation stays
          valid — ask an owner to free a seat or buy more, then open this link again.
        </p>
        <GoToProjects />
      </Card>
    );
  }

  return (
    <Card icon="group_add" title={`Join ${invitation.organizationName}`}>
      <p className={BODY_CLASS}>
        {invitation.inviterName} invited you to collaborate in{" "}
        <strong className="text-foreground">{invitation.organizationName}</strong>.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        {/* Declining is not destructive — it withdraws a request nobody has
            acted on — so it is the quiet button rather than the red one. It
            also has to exist: without it the only way to say no is to ignore
            the mail, which leaves the invitation sitting on the owner's page
            forever looking like it might still be accepted. */}
        <Button
          variant="ghost"
          onClick={() =>
            decline.mutate(
              { invitationId },
              { onSuccess: () => void navigate({ to: "/projects" }) }
            )
          }
          disabled={accept.isPending}
          pending={decline.isPending}
        >
          Decline
        </Button>
        <Button
          onClick={() =>
            accept.mutate({ invitationId }, { onSuccess: () => void navigate({ to: "/projects" }) })
          }
          disabled={decline.isPending}
          pending={accept.isPending}
        >
          Accept invitation
        </Button>
      </div>
      <ActionError error={accept.error ?? decline.error} />
    </Card>
  );
}

function Card({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className={PAGE_CLASS}>
      <div className={CARD_CLASS}>
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-neutral-800 text-2xl text-neutral-400">
          <Icon name={icon} />
        </span>
        <h1 className={`${TITLE_CLASS} mt-3`}>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function GoToProjects({ variant = "secondary" }: { variant?: "secondary" | "ghost" }) {
  return (
    <div className={variant === "ghost" ? "" : "mt-5 flex justify-center"}>
      <Button nativeButton={false} render={<Link to="/projects" />} variant={variant}>
        Go to projects
      </Button>
    </div>
  );
}

/**
 * These come from better-auth, which writes them for people — the seat check in
 * `auth.ts` produces "This organization has no seats left (12 in total)". None
 * of them can carry driver-level detail, so they are shown as-is.
 */
function ActionError({ error }: { error: Error | null }) {
  if (!error) return null;

  return (
    <p role="alert" className="mt-3 text-sm text-red-400">
      {error.message}
    </p>
  );
}
