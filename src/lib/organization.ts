import type { Member, Organization } from "better-auth/plugins";
import type { DBAdapter, User } from "better-auth/types";
import { count, eq } from "drizzle-orm";

import { getDB, schema } from "#/db";
import type { OrganizationType } from "#/db/schema";

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
 * Seats a new organization is allowed before anyone pays for more.
 *
 * Placeholders: there is no subscription in this app yet, so these are what
 * stands in for one. A `private` workspace is its owner and no one else, which
 * is the real rule rather than a starting point. The other two are a guess at a
 * useful free tier — the number a plan grants belongs to billing, and this is
 * the seam it will replace.
 */
export const DEFAULT_SEATS = {
  private: 1,
  team: 5,
  enterprise: 25
} as const satisfies Record<OrganizationType, number>;

function localPart(email: string) {
  return email.split("@")[0];
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function privateOrganizationName(user: OrganizationOwner) {
  return `${user.name.trim() || localPart(user.email)}'s Organization`;
}

/**
 * `organization.slug` is unique across the whole table, so a taken slug is
 * retried with a random suffix instead of failing the sign up.
 */
async function generateSlug(adapter: DBAdapter, user: OrganizationOwner) {
  const base = slugify(localPart(user.email)) || slugify(user.name) || FALLBACK_SLUG;
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
