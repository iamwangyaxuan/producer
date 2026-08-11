import type { Member, Organization } from "better-auth/plugins";
import type { DBAdapter, User } from "better-auth/types";

/**
 * Every user owns exactly one personal organization, linked through
 * `organization.personalOwnerId`. It is created on sign up and used as the
 * fallback active organization whenever a session has none.
 */
export type PersonalOrganization = Organization & { personalOwnerId: string | null };

type PersonalOrganizationOwner = Pick<User, "id" | "name" | "email">;

const OWNER_ROLE = "owner";

const FALLBACK_SLUG = "organization";

function localPart(email: string) {
  return email.split("@")[0] ?? "";
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function personalOrganizationName(user: PersonalOrganizationOwner) {
  return `${user.name.trim() || localPart(user.email)}'s Organization`;
}

/**
 * `organization.slug` is unique across the whole table, so a taken slug is
 * retried with a random suffix instead of failing the sign up.
 */
async function generateSlug(adapter: DBAdapter, user: PersonalOrganizationOwner) {
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

export function findPersonalOrganization(adapter: DBAdapter, userId: string) {
  return adapter.findOne<PersonalOrganization>({
    model: "organization",
    where: [{ field: "personalOwnerId", value: userId }]
  });
}

async function createPersonalOrganization(adapter: DBAdapter, user: PersonalOrganizationOwner) {
  const organization = await adapter.create<PersonalOrganization>({
    model: "organization",
    data: {
      name: personalOrganizationName(user),
      slug: await generateSlug(adapter, user),
      personalOwnerId: user.id,
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
 * users created before this hook existed still get their personal organization.
 */
export async function ensurePersonalOrganization(
  adapter: DBAdapter,
  user: PersonalOrganizationOwner
) {
  return (
    (await findPersonalOrganization(adapter, user.id)) ?? createPersonalOrganization(adapter, user)
  );
}

/**
 * Same as {@link ensurePersonalOrganization}, but starting from a user id —
 * used by the session hook, which only knows `session.userId`. Returns `null`
 * when the user is not visible to `adapter`, which is the case while a sign up
 * transaction is still open; {@link activateForNewUser} covers that path.
 */
export async function ensurePersonalOrganizationById(adapter: DBAdapter, userId: string) {
  const existing = await findPersonalOrganization(adapter, userId);
  if (existing) return existing;

  const user = await adapter.findOne<User>({
    model: "user",
    where: [{ field: "id", value: userId }]
  });
  if (!user) return null;

  return createPersonalOrganization(adapter, user);
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
