import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { count, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getDB, schema } from "#/db";
import { auth } from "#/lib/auth";
import { authClient } from "#/lib/auth-client";
import { canonicalId } from "#/lib/ids";

/*
 * The other side of `members.ts`.
 *
 * That file is the owner's view and is gated on being the owner; this one is
 * the recipient's, and is gated on being the person the invitation was sent to.
 * Two different questions about the same rows, which is why they are two files
 * rather than one with a role check threaded through it.
 */

/**
 * Every state the accept page can be in, as a discriminated union rather than
 * an object with a nullable `blocker`. Each case carries exactly the strings
 * its screen needs, so no branch can read a field that means nothing to it —
 * and there is no way to render "join" for a state that cannot.
 */
export type InvitationView =
  /** Missing, already used, revoked, or past its expiry. All indistinguishable. */
  | { state: "unavailable" }
  /** Signed in as somebody else. The commonest real failure, and recoverable. */
  | { state: "wrong-account"; invitedEmail: string; viewerEmail: string }
  /** better-auth refuses to accept on an unverified address — see the page. */
  | { state: "unverified"; organizationName: string; viewerEmail: string }
  /** The organization has no seat to put this person in. */
  | { state: "full"; organizationName: string }
  | { state: "ready"; organizationName: string; inviterName: string; expiresAt: Date };

/**
 * `z.string()` rather than `canonicalId`, deliberately, for the same reason
 * `fetchProject` does it: the id comes straight out of a URL somebody was
 * emailed, and a mistyped one has to reach the same "this invitation is no
 * longer valid" screen as a well-formed one that matches nothing — not an
 * error boundary.
 */
const invitationInput = z.object({ id: z.string() });

export const fetchInvitation = createServerFn({ method: "GET" })
  .validator(invitationInput)
  .handler(async ({ data }): Promise<InvitationView> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });

    // The `_auth` guard redirects an anonymous visitor to sign in first, so
    // this only fires for a session that expired between the two.
    if (!session) return { state: "unavailable" };

    if (!canonicalId.safeParse(data.id).success) return { state: "unavailable" };

    const db = getDB();
    const inviter = alias(schema.user, "inviter");

    const [row] = await db
      .select({
        email: schema.invitation.email,
        status: schema.invitation.status,
        expiresAt: schema.invitation.expiresAt,
        organizationId: schema.organization.id,
        organizationName: schema.organization.name,
        seat: schema.organization.seat,
        inviterName: inviter.name,
        inviterEmail: inviter.email
      })
      .from(schema.invitation)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
      .innerJoin(inviter, eq(inviter.id, schema.invitation.inviterId))
      .where(eq(schema.invitation.id, data.id))
      .limit(1);

    if (!row || row.status !== "pending" || row.expiresAt < new Date()) {
      return { state: "unavailable" };
    }

    // Case-insensitive because addresses are: better-auth lowercases what it
    // stores and compares the same way when accepting, so matching that here is
    // what keeps this page's answer and the endpoint's agreeing.
    if (row.email.toLowerCase() !== session.user.email.toLowerCase()) {
      return {
        state: "wrong-account",
        invitedEmail: row.email,
        viewerEmail: session.user.email
      };
    }

    /**
     * better-auth refuses to accept an invitation on an unverified address
     * whenever invitation ids are not its own opaque ones — and ours are
     * database-generated uuids, so that is us. The rule is worth keeping rather
     * than switching off: anyone can sign up as `someone@company.com` without
     * proving they read that mailbox, and without this check that account could
     * walk into the organization the real owner of the address was invited to.
     */
    if (!session.user.emailVerified) {
      return {
        state: "unverified",
        organizationName: row.organizationName,
        viewerEmail: session.user.email
      };
    }

    // Said here rather than discovered on submit: the seat check runs inside
    // `beforeAcceptInvitation`, and "the button did nothing but show an error"
    // is a worse way to learn the team is full.
    const [tally] = await db
      .select({ members: count() })
      .from(schema.member)
      .where(eq(schema.member.organizationId, row.organizationId));

    if (tally.members >= row.seat) {
      return { state: "full", organizationName: row.organizationName };
    }

    return {
      state: "ready",
      organizationName: row.organizationName,
      inviterName: row.inviterName.trim() || row.inviterEmail,
      expiresAt: row.expiresAt
    };
  });

/**
 * Not under the `["organizations", …]` prefix: this is about an organization
 * the reader does not belong to yet, so the invalidation the membership writes
 * fire has nothing to say about it. Keyed by invitation id alone, since that is
 * the whole of what identifies it.
 */
export function invitationQueryOptions(invitationId: string) {
  return queryOptions({
    queryKey: ["invitations", invitationId],
    queryFn: ({ signal }) => fetchInvitation({ data: { id: invitationId }, signal }),
    staleTime: 30_000
  });
}

function unwrap(result: { error?: { message?: string } | null }, fallback: string) {
  if (result.error) throw new Error(result.error.message ?? fallback);
}

/**
 * Accepting, and then moving in.
 *
 * The switch is part of the action rather than a separate step: someone who has
 * just joined an organization is here to see it, and leaving them scoped to
 * their private workspace would mean the projects page shows nothing and the
 * only clue is a switcher they have not been told about. It is allowed to fail
 * on its own, though — the membership is real either way, and the switcher
 * fixes a missed switch.
 */
export function useAcceptInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { invitationId: string; organizationId?: string }) => {
      const result = await authClient.organization.acceptInvitation({
        invitationId: variables.invitationId
      });

      unwrap(result, "Could not accept that invitation.");

      const organizationId = result.data?.invitation?.organizationId;

      if (organizationId) {
        await authClient.organization.setActive({ organizationId }).catch(() => undefined);
      }
    },
    onSuccess: async () => {
      // The membership, the session's scope, and every organization-scoped read
      // have all just changed.
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
    }
  });
}

export function useDeclineInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { invitationId: string }) => {
      const result = await authClient.organization.rejectInvitation({
        invitationId: variables.invitationId
      });

      unwrap(result, "Could not decline that invitation.");
    },
    // Only this page's own read: declining changes nothing about the
    // organizations the reader is already in.
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({ queryKey: ["invitations", variables.invitationId] })
  });
}

/**
 * Sends the address confirmation that unblocks accepting.
 *
 * `callbackURL` points back at the invitation, so verifying lands the person
 * exactly where they were rather than on a generic "you are verified" page with
 * no way onwards. Nothing else in this app sends this mail — see
 * `emailVerification` in `auth.ts` for why it is not sent at sign up.
 */
export function useSendVerificationEmail() {
  return useMutation({
    mutationFn: async (variables: { email: string; callbackURL: string }) => {
      const result = await authClient.sendVerificationEmail({
        email: variables.email,
        callbackURL: variables.callbackURL
      });

      unwrap(result, "Could not send the verification email.");
    }
  });
}
