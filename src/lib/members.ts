import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq, gt } from "drizzle-orm";

import { getDB, schema } from "#/db";
import type { OrganizationType } from "#/db/schema";
import { auth } from "#/lib/auth";
import { authClient } from "#/lib/auth-client";

/** A person who already occupies a seat. */
export interface OrganizationMember {
  /** The `member` row, which is what removal is addressed to — not the user. */
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  joinedAt: Date;
}

/** An invitation that has been sent and not yet acted on. */
export interface PendingInvitation {
  id: string;
  email: string;
  role: string | null;
  expiresAt: Date;
}

export interface OrganizationMembers {
  /**
   * `null` whenever there is nothing here for this user to manage: no session,
   * no active organization, a private workspace (which is one person by
   * definition), or a membership that is not the owner's. All four collapse to
   * the same answer on purpose — the page has one thing to say in every one of
   * them, and none of them should reveal who else is in the organization.
   */
  organization: { id: string; name: string; type: OrganizationType; seat: number } | null;
  members: OrganizationMember[];
  invitations: PendingInvitation[];
  /** So the page can refuse to offer "remove" against the person reading it. */
  viewerUserId: string;
}

const NOTHING_TO_MANAGE: OrganizationMembers = {
  organization: null,
  members: [],
  invitations: [],
  viewerUserId: ""
};

/**
 * Everyone in the active organization, plus the invitations still outstanding.
 *
 * Scoped like every other read here: the organization comes from the session
 * cookie and never from the caller, and membership is re-checked against
 * `member` rather than trusted from `activeOrganizationId` — that column is a
 * snapshot which outlives a revoked membership.
 *
 * The owner check is here rather than only in the sidebar. A hidden link is not
 * a permission, and this endpoint is a plain HTTP route that anyone signed in
 * can call; the roster of an organization is exactly the sort of thing that
 * should not come back to someone who merely knows the URL.
 */
export const fetchOrganizationMembers = createServerFn({ method: "GET" }).handler(
  async (): Promise<OrganizationMembers> => {
    const session = await auth.api.getSession({ headers: getRequest().headers });
    const activeOrganizationId = session?.session.activeOrganizationId;

    if (!session || !activeOrganizationId) return NOTHING_TO_MANAGE;

    const db = getDB();

    // One statement for two questions: which organization this is, and what
    // this user is in it. The join is the membership check.
    const [viewer] = await db
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        type: schema.organization.type,
        seat: schema.organization.seat,
        role: schema.member.role
      })
      .from(schema.organization)
      .innerJoin(
        schema.member,
        and(
          eq(schema.member.organizationId, schema.organization.id),
          eq(schema.member.userId, session.user.id)
        )
      )
      .where(eq(schema.organization.id, activeOrganizationId))
      .limit(1);

    if (!viewer || viewer.type === "private" || viewer.role !== "owner") {
      return NOTHING_TO_MANAGE;
    }

    const [members, invitations] = await Promise.all([
      db
        .select({
          id: schema.member.id,
          userId: schema.user.id,
          name: schema.user.name,
          email: schema.user.email,
          image: schema.user.image,
          role: schema.member.role,
          joinedAt: schema.member.createdAt
        })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, activeOrganizationId))
        // Oldest first, so the owner is at the top and the list does not
        // reorder itself as people join. `id` breaks ties so the order is
        // total — rows sharing a timestamp must not swap places between the
        // server render and a client refetch.
        .orderBy(asc(schema.member.createdAt), asc(schema.member.id)),
      db
        .select({
          id: schema.invitation.id,
          email: schema.invitation.email,
          role: schema.invitation.role,
          expiresAt: schema.invitation.expiresAt
        })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.organizationId, activeOrganizationId),
            eq(schema.invitation.status, "pending"),
            // An expired invitation cannot be accepted and cannot be revived,
            // so listing it would only be a row with nothing to do about it.
            // They are left in the table rather than deleted: the record of who
            // was invited is worth keeping.
            gt(schema.invitation.expiresAt, new Date())
          )
        )
        .orderBy(asc(schema.invitation.expiresAt), asc(schema.invitation.id))
    ]);

    return {
      organization: {
        id: viewer.id,
        name: viewer.name,
        type: viewer.type,
        seat: viewer.seat
      },
      members,
      invitations,
      viewerUserId: session.user.id
    };
  }
);

/**
 * Under the organization prefix, so the invalidation every write in this file
 * fires reaches it — and so switching organization drops it along with
 * everything else scoped to the one being left.
 */
export function organizationMembersQueryOptions(organizationId: string | null | undefined) {
  return queryOptions({
    queryKey: ["organizations", organizationId ?? null, "members"],
    queryFn: ({ signal }) => fetchOrganizationMembers({ signal }),
    // Same reason as the other reads: the route loader resolves this during
    // SSR, and at 0 the hydrated entry refetches the moment it mounts.
    staleTime: 30_000
  });
}

/** The longest an address can be; the form caps the field at it. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * The three writes, all through better-auth rather than through Drizzle.
 *
 * That is not a stylistic choice: `inviteMember` is what sends the email,
 * `removeMember` is what runs the organization hooks, and accepting later runs
 * the seat check in `auth.ts`. Writing `member` and `invitation` directly would
 * skip every one of those — which is precisely the gap SSO and SCIM already
 * have, and not one worth widening from our own UI.
 *
 * `organizationId` is never passed. Each endpoint falls back to the session's
 * active organization, which is the same rule the rest of this app follows: the
 * server decides the tenant, the client does not get to name it.
 */
function useMembersMutation<TVariables>(mutationFn: (variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    // Returned rather than fired and forgotten, so the mutation stays pending
    // until the list has caught up — a row disappears once it is really gone,
    // not while the request is still in flight.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["organizations"] })
  });
}

/** better-auth reports refusals in the payload rather than by rejecting. */
function unwrap(result: { error?: { message?: string } | null }, fallback: string) {
  if (result.error) throw new Error(result.error.message ?? fallback);
}

export function useInviteMember() {
  return useMembersMutation(async (variables: { email: string }) => {
    const result = await authClient.organization.inviteMember({
      email: variables.email,
      // The one role this UI hands out. better-auth also understands `admin`,
      // and the billing check in `organization.ts` already accepts it — but
      // nothing creates one yet, and a role selector is a bigger decision than
      // "let the owner add people".
      role: "member",
      // Re-inviting an address that already has a live invitation replaces it
      // rather than failing, which is what makes the button safe to press twice
      // when the first email did not arrive.
      resend: true
    });

    unwrap(result, "Could not send that invitation.");
  });
}

export function useCancelInvitation() {
  return useMembersMutation(async (variables: { invitationId: string }) => {
    const result = await authClient.organization.cancelInvitation({
      invitationId: variables.invitationId
    });

    unwrap(result, "Could not cancel that invitation.");
  });
}

export function useRemoveMember() {
  return useMembersMutation(async (variables: { memberId: string }) => {
    const result = await authClient.organization.removeMember({
      // The `member` row id, not the user's — an address would be ambiguous
      // across organizations, and this endpoint accepts either.
      memberIdOrEmail: variables.memberId
    });

    unwrap(result, "Could not remove that member.");
  });
}
