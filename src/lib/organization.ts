import type { Member, Organization } from "better-auth/plugins";
import type { DBAdapter, User } from "better-auth/types";
import { and, count, eq } from "drizzle-orm";

import { getDB, schema } from "#/db";
import type { OrganizationType } from "#/db/schema";
import { canonicalId } from "#/lib/ids";

/**
 * better-auth's `Organization` plus the columns this app adds — see the table
 * in `db/schema.ts` for what each one is for. Declared here because the plugin's
 * own type stops at the fields it defines, and every read through the adapter in
 * this file wants the rest.
 */
export type ProducerOrganization = Organization & {
  ownerId: string;
  type: OrganizationType;
  seat: number;
};

type OrganizationOwner = Pick<User, "id" | "name" | "email">;

const OWNER_ROLE = "owner";

const FALLBACK_SLUG = "organization";

/** The one type a user may only hold once, guarded by a partial unique index. */
export const PRIVATE_TYPE = "private" satisfies OrganizationType;

/** What a client is allowed to ask for; `private` is created by sign up only. */
export const CREATABLE_TYPES = [
  "team",
  "enterprise"
] as const satisfies readonly OrganizationType[];

export type CreatableOrganizationType = (typeof CREATABLE_TYPES)[number];

export function isCreatableType(value: unknown): value is CreatableOrganizationType {
  return CREATABLE_TYPES.includes(value as CreatableOrganizationType);
}

/**
 * Seats an organization gets when nobody paid for a number.
 *
 * A `private` workspace is its owner and no one else, which is the real rule
 * rather than a starting point. The other two are now only a floor for
 * organizations that did not come through checkout — better-auth's own
 * `/organization/create` endpoint still works and still has to produce a valid
 * row — because the product path mints the seat count from what was bought.
 * See `applyPurchasedOrganization` below for where a real number comes from.
 */
export const DEFAULT_SEATS = {
  private: 1,
  team: 5,
  enterprise: 25
} as const satisfies Record<OrganizationType, number>;

/**
 * The name an address carries on its own: the part before the `@`, minus any
 * plus-addressing tag.
 *
 * `foo+producer@example.com` is `foo`'s mailbox with a label attached — the tag
 * exists so the recipient can tell later who they gave the address to, and it
 * is no more part of their name than the domain is. Left in, it would show up
 * as `foo+producer's Organization` on the first screen they ever see.
 *
 * Only the tag is dropped, and only for *display*: `user.email` keeps every
 * character it arrived with, because that string is what mail is delivered to
 * and what an invitation is matched against.
 *
 * Dots are deliberately not touched. Gmail ignores them, but Gmail is the only
 * one — for most domains `zhang.san@` and `zhangsan@` are two different people,
 * and "normalizing" them would merge two strangers.
 *
 * Exported because three places want the same answer: the sign-up hook in
 * `auth.ts` fills a blank `user.name` with it, and the two functions below
 * derive an organization name and a slug from it.
 */
export function nameFromEmail(email: string) {
  const local = email.split("@")[0];
  const tag = local.indexOf("+");

  // `> 0` rather than `!== -1`: an address whose local part *starts* with `+`
  // is unusual but legal, and trimming there would leave nothing at all.
  return tag > 0 ? local.slice(0, tag) : local;
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/**
 * The `user.create.before` hook in `auth.ts` has already filled a blank name
 * with the address's local part, so this normally reads straight off `name`.
 * The fallback stays as a second line of defence — this is also reachable from
 * `ensurePrivateOrganizationById` for accounts created before that hook existed.
 */
export function privateOrganizationName(user: OrganizationOwner) {
  return `${user.name.trim() || nameFromEmail(user.email)}'s Organization`;
}

/**
 * `organization.slug` is unique across the whole table, so a taken slug is
 * retried with a random suffix instead of failing the sign up.
 */
async function generateSlug(adapter: DBAdapter, user: OrganizationOwner) {
  const base = slugify(nameFromEmail(user.email)) || slugify(user.name) || FALLBACK_SLUG;
  let candidate = base;

  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = await adapter.findOne<Organization>({
      model: "organization",
      where: [{ field: "slug", value: candidate }]
    });

    if (!taken) break;

    candidate = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  }

  return candidate;
}

/**
 * Both conditions matter: `ownerId` alone would now match the teams this user
 * owns as well, and there is exactly one row where it is paired with `private`.
 */
export function findPrivateOrganization(adapter: DBAdapter, userId: string) {
  return adapter.findOne<ProducerOrganization>({
    model: "organization",
    where: [
      { field: "ownerId", value: userId },
      { field: "type", value: PRIVATE_TYPE }
    ]
  });
}

async function createPrivateOrganization(adapter: DBAdapter, user: OrganizationOwner) {
  const organization = await adapter.create<ProducerOrganization>({
    model: "organization",
    data: {
      name: privateOrganizationName(user),
      slug: await generateSlug(adapter, user),
      ownerId: user.id,
      type: PRIVATE_TYPE,
      // One seat, for the owner's own membership written immediately below.
      // A private workspace is not a place other people are invited into, so
      // this is the whole allowance rather than a starting balance.
      seat: DEFAULT_SEATS.private,
      createdAt: new Date()
    }
  });

  await adapter.create<Member>({
    model: "member",
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: OWNER_ROLE,
      createdAt: new Date()
    }
  });

  return organization;
}

/**
 * Idempotent: safe to call on every sign up and again on every sign in, so
 * users created before this hook existed still get their private organization.
 *
 * The read-then-create is not atomic, and two sign-ins racing each other is a
 * real sequence, not a theoretical one — a browser restoring several tabs does
 * it. The partial unique index on (`ownerId` where type = 'private') is what
 * actually decides the winner; the loser reads the row the winner wrote instead
 * of failing a sign in over it.
 */
export async function ensurePrivateOrganization(adapter: DBAdapter, user: OrganizationOwner) {
  const existing = await findPrivateOrganization(adapter, user.id);
  if (existing) return existing;

  try {
    return await createPrivateOrganization(adapter, user);
  } catch (error) {
    const raced = await findPrivateOrganization(adapter, user.id);
    if (!raced) throw error;

    return raced;
  }
}

/**
 * Same as {@link ensurePrivateOrganization}, but starting from a user id —
 * used by the session hook, which only knows `session.userId`. Returns `null`
 * when the user is not visible to `adapter`, which is the case while a sign up
 * transaction is still open; {@link activateForNewUser} covers that path.
 */
export async function ensurePrivateOrganizationById(adapter: DBAdapter, userId: string) {
  const existing = await findPrivateOrganization(adapter, userId);
  if (existing) return existing;

  const user = await adapter.findOne<User>({
    model: "user",
    where: [{ field: "id", value: userId }]
  });
  if (!user) return null;

  return ensurePrivateOrganization(adapter, user);
}

/**
 * Sign up creates the user and its first session inside a single transaction,
 * and `user.create.after` only runs once that transaction has committed — too
 * late for the session hook to have seen the organization. Because the user was
 * just created, every session they own belongs to that sign up.
 */
export async function activateForNewUser(
  adapter: DBAdapter,
  userId: string,
  organizationId: string
) {
  await adapter.updateMany({
    model: "session",
    where: [{ field: "userId", value: userId }],
    update: { activeOrganizationId: organizationId }
  });
}

/** How many members currently occupy a seat. */
export async function countMembers(organizationId: string) {
  const [row] = await getDB()
    .select({ members: count() })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId));

  return row.members;
}

/**
 * Whether the organization has room for one more member.
 *
 * Advisory, and knowingly so: the check and the insert that follows it are not
 * one atomic step — better-auth writes the `member` row itself, after this
 * returns — so two invitations accepted at the same instant can both see the
 * last free seat. Closing that would take a constraint the database can enforce
 * (a trigger counting rows against `seat`), which is a heavier mechanism than
 * the failure deserves: the overshoot is bounded by how many joins land in the
 * same moment, and a paid ceiling is reconciled against billing anyway. What
 * this does buy is the ordinary case — a full team gets a clear refusal instead
 * of silently growing past what it pays for.
 */
export async function hasFreeSeat(organizationId: string, seat: number) {
  return (await countMembers(organizationId)) < seat;
}

/* -------------------------------------------------------------------------- */
/* Buying an organization                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Roles allowed to spend money in an organization's name. Members can use what
 * has been paid for; they cannot change what is being paid for.
 */
const BILLING_ROLES = new Set(["owner", "admin"]);

/**
 * Whether this user may run a subscription action against this reference — the
 * question `authorizeReference` in `auth.ts` has to answer for every call the
 * Stripe plugin accepts.
 *
 * Two sources, because a reference id names an organization at two different
 * points in its life. Once the organization exists, `member` is the authority,
 * the same as everywhere else in this app. Before it exists — which is the
 * normal case here, since seats are bought first — the only thing that can
 * vouch for the id is the draft that minted it, and only for the person who
 * started it.
 *
 * A malformed id is refused before either query: it can only be a forgery or a
 * bug, and both should look the same from outside.
 */
export async function authorizeOrganizationBilling(userId: string, referenceId: string) {
  if (!canonicalId.safeParse(referenceId).success) return false;

  const db = getDB();

  const [membership] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, referenceId), eq(schema.member.userId, userId)))
    .limit(1);

  if (membership) return BILLING_ROLES.has(membership.role);

  const [draft] = await db
    .select({ id: schema.organizationDraft.id })
    .from(schema.organizationDraft)
    .where(
      and(
        eq(schema.organizationDraft.id, referenceId),
        eq(schema.organizationDraft.userId, userId),
        // A draft that has already been paid for or walked away from is not a
        // licence to start another checkout against the same id.
        eq(schema.organizationDraft.status, "pending")
      )
    )
    .limit(1);

  return Boolean(draft);
}

/** `organization.slug` is unique table-wide, so a taken one gets a random tail. */
async function availableSlug(db: ReturnType<typeof getDB>, name: string) {
  const base = slugify(name) || FALLBACK_SLUG;
  let candidate = base;

  for (let attempt = 0; attempt < 5; attempt++) {
    const [taken] = await db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, candidate))
      .limit(1);

    if (!taken) break;

    candidate = `${base}-${crypto.randomUUID().slice(0, 8)}`;
  }

  return candidate;
}

export interface PurchasedOrganization {
  organizationId: string;
  /** False when the row was already there — a replay, or a later seat change. */
  created: boolean;
}

/**
 * Turns a completed subscription into the organization it paid for.
 *
 * This is the one place `organization.seat` is written from what someone
 * actually bought, and the reason the whole checkout can name a tenant that has
 * no row yet: `referenceId` was minted as a draft id and becomes the
 * organization's id verbatim, so the subscription points at the finished
 * organization from the moment it is created rather than being repointed after.
 *
 * Called from the plugin's `onSubscriptionComplete`, which is reached through
 * the webhook — and therefore has to be safe to run twice, because Stripe
 * redelivers. It is idempotent in both directions:
 *
 * - the organization already exists → the seat count is brought in line with
 *   the subscription and nothing else changes, which is also exactly what a
 *   later seat change wants;
 * - it does not → it and its owner's membership are written in one transaction,
 *   so there is no window where an organization exists that nobody belongs to.
 *
 * `null` means the reference is not an organization this app knows how to
 * create — an id with no draft and no row behind it. That is a legitimate
 * answer rather than an error: the caller is a webhook handler, and refusing to
 * invent a tenant for an id we cannot account for is the safe direction.
 */
export async function applyPurchasedOrganization(input: {
  referenceId: string;
  seats: number;
}): Promise<PurchasedOrganization | null> {
  if (!canonicalId.safeParse(input.referenceId).success) return null;

  const db = getDB();
  // The CHECK on the column is `>= 1`; a subscription reporting fewer seats
  // than that is nonsense we should not write, not a reason to fail a webhook.
  const seat = Math.max(1, Math.trunc(input.seats));

  const [existing] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, input.referenceId))
    .limit(1);

  if (existing) {
    await db
      .update(schema.organization)
      .set({ seat })
      .where(eq(schema.organization.id, existing.id));

    // Redundant on a replay, load-bearing when the first attempt created the
    // organization and then failed before it got here.
    await db
      .update(schema.organizationDraft)
      .set({ status: "completed" })
      .where(eq(schema.organizationDraft.id, existing.id));

    return { organizationId: existing.id, created: false };
  }

  const [draft] = await db
    .select()
    .from(schema.organizationDraft)
    .where(eq(schema.organizationDraft.id, input.referenceId))
    .limit(1);

  if (!draft) return null;

  // The slug is picked outside the transaction and can lose a race with another
  // organization claiming it in between, which surfaces as a unique violation
  // rather than something worth checking for twice. Each attempt re-reads, so a
  // collision resolves on the next pass instead of retrying the same name.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = await availableSlug(db, draft.name);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(schema.organization).values({
          // Not a default: this id was promised to the subscription before any
          // of this existed, and every reference to it already uses that value.
          id: draft.id,
          name: draft.name,
          slug,
          ownerId: draft.userId,
          type: draft.type,
          seat,
          createdAt: new Date()
        });

        await tx.insert(schema.member).values({
          organizationId: draft.id,
          userId: draft.userId,
          role: OWNER_ROLE,
          createdAt: new Date()
        });

        await tx
          .update(schema.organizationDraft)
          .set({ status: "completed" })
          .where(eq(schema.organizationDraft.id, draft.id));
      });

      return { organizationId: draft.id, created: true };
    } catch (error) {
      // A concurrent delivery of the same event got there first — the outcome
      // we wanted, reached by somebody else.
      const [raced] = await db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, draft.id))
        .limit(1);

      if (raced) return { organizationId: raced.id, created: false };

      if (attempt === 4) throw error;
    }
  }

  return null;
}
