import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

const generate_id_fun = "uuidv7()";

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const user = pgTable("user", {
  id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: tstz("created_at").defaultNow().notNull(),
  updatedAt: tstz("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: tstz("ban_expires")
});

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    expiresAt: tstz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: uuid("impersonated_by"),
    activeOrganizationId: uuid("active_organization_id")
  },
  (table) => [index("session_userId_idx").on(table.userId)]
);

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tstz("access_token_expires_at"),
    refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [index("account_userId_idx").on(table.userId)]
);

export const verification = pgTable(
  "verification",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const ORGANIZATION_TYPES = ["private", "team", "enterprise"] as const;

export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/**
 * `type` splits what used to be one nullable `personalOwnerId` column doing two
 * jobs at once — "who owns this" and "is this the personal one". Separating them
 * is what lets a user own more than one organization: exactly one `private`
 * (their own workspace, created at sign up) and any number of `team` /
 * `enterprise` ones.
 *
 * `ownerId` is not a membership — the owner is also a row in `member`, and every
 * authorization path reads `member`, never this column. What it records is who
 * the organization belongs to for billing and lifecycle purposes, which is why
 * it is `restrict` rather than `cascade`: deleting a user whose organizations
 * still exist has to be a deliberate act (reassign or delete them first), not a
 * silent cascade that takes a whole team's projects and assets with it.
 */
export const organization = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: tstz("created_at").notNull(),
    metadata: text("metadata"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    type: text("type").$type<OrganizationType>().notNull(),
    /**
     * How many members this organization has *paid for* — a ceiling, not a
     * count. It is an input, set by whatever decides billing, and deliberately
     * never derived from `member`: the whole point of a purchased limit is that
     * it stays put while the membership moves under it. `member` is the tally,
     * this is the allowance, and a full team sits at the point where the two
     * are equal.
     *
     * At least 1, because an organization always holds its owner. Nothing in
     * the app writes this column yet — see `DEFAULT_SEATS` for what a new
     * organization starts with, and the seat check in `auth.ts` for where the
     * ceiling is actually enforced.
     */
    seat: integer("seat").default(1).notNull()
  },
  (table) => [
    index("organization_ownerId_idx").on(table.ownerId),
    // The "one private organization per user" rule, enforced where it cannot be
    // raced: two concurrent sign ins for the same user would both pass an
    // application-level check. Partial, so it says nothing about how many teams
    // the same user owns.
    uniqueIndex("organization_private_owner_idx")
      .on(table.ownerId)
      .where(sql`${table.type} = 'private'`),
    check("organization_type_check", sql`${table.type} in ('private', 'team', 'enterprise')`),
    check("organization_seat_check", sql`${table.seat} >= 1`)
  ]
);

export const member = pgTable(
  "member",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: tstz("created_at").notNull()
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId)
  ]
);

export const invitation = pgTable(
  "invitation",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" })
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email)
  ]
);

export const ssoProvider = pgTable("sso_provider", {
  id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: uuid("organization_id"),
  domain: text("domain").notNull()
});

export const scimProvider = pgTable("scim_provider", {
  id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
  providerId: text("provider_id").notNull().unique(),
  scimToken: text("scim_token").notNull().unique(),
  organizationId: uuid("organization_id")
});

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").default("Untitled project").notNull(),
    description: text("description"),
    image: text("image"),
    archived: boolean("archived").default(false).notNull(),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [
    index("project_organizationId_idx").on(table.organizationId),
    index("project_createdBy_idx").on(table.createdBy)
  ]
);

/**
 * Provider-shaped request parameters, stored verbatim. Vocabularies differ per
 * model ("1K" vs "1080p", ratio lists, duration sets), so these are display /
 * re-run data, not relational data. Measured output facts (width, height,
 * durationSeconds) live in real columns instead.
 */
export interface GenerationParams {
  resolution?: string;
  aspectRatio?: string;
  /** Requested seconds — the measured length goes in `durationSeconds`. */
  duration?: number;
  seed?: number;
  [key: string]: unknown;
}

export const ASSET_SOURCES = ["ai", "upload"] as const;
export const ASSET_KINDS = ["image", "voice", "music", "video"] as const;
export const ASSET_STATUSES = ["pending", "ready", "failed"] as const;

export type AssetSource = (typeof ASSET_SOURCES)[number];
export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/**
 * One row per stored media file — AI generations and user uploads share the
 * table because they share everything that matters: the R2 object key
 * contract, the org-scoped authorization path, the serving endpoint, and the
 * reference graph (an uploaded image can feed a generation).
 *
 * The row is always inserted before any byte reaches R2, with `objectKey`
 * already final, so the bucket can never hold an object the database has no
 * record of — every possible orphan is discoverable from here.
 */
export const asset = pgTable(
  "asset",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    // Denormalized on purpose: the media-serving hot path authorizes with one
    // indexed lookup instead of a join through `project`, and the org barrier
    // keeps holding after a project is deleted.
    //
    // `restrict`, not `cascade`, for the same reason `projectId` is `set null`:
    // a cascade would delete the rows while their objects stayed in the bucket,
    // and with the rows go the only object keys anything could clean up by —
    // the whole org's bytes, orphaned for good. Deleting an organization must
    // therefore tombstone its assets first and let the sweep drain them; until
    // it does, Postgres refuses, which is a loud failure rather than a silent
    // and permanent one. Nothing in the app deletes an organization today.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    // Nullable + set null: the row must outlive the project, because it is the
    // only record of the R2 object — cascading it away would strand bytes in
    // the bucket with nothing left to clean them up by.
    projectId: uuid("project_id").references(() => project.id, { onDelete: "set null" }),
    source: text("source").$type<AssetSource>().notNull(),
    kind: text("kind").$type<AssetKind>().notNull(),
    // One in-flight value for both sources — whether a `pending` row is an
    // upload awaiting bytes or a generation awaiting a provider is already
    // said by `source`; a second column saying it again would drift.
    status: text("status").$type<AssetStatus>().default("pending").notNull(),
    /** User-facing failure reason; null unless status = 'failed'. */
    error: text("error"),
    objectKey: text("object_key").notNull().unique(),
    /**
     * What R2 answered with when the bytes were accepted, recorded so serving
     * can tell the object apart from a later one at the same key. An upload's
     * presigned URL stays usable for its whole (short) lifetime, including
     * after completion, so without this a member could re-PUT different bytes
     * behind a row that had already been measured and called ready. The
     * serving route refuses anything whose ETag has moved.
     */
    etag: text("etag"),
    // Nullable while pending: an AI row is inserted before the provider has
    // answered, so what came back is only known when the row flips to ready.
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** Original filename as uploaded, display-only; null for AI assets. */
    filename: text("filename"),
    // Measured output facts, queryable across providers — unlike the request
    // parameters in `params`, whose vocabulary each provider owns.
    width: integer("width"),
    height: integer("height"),
    durationSeconds: doublePrecision("duration_seconds"),
    prompt: text("prompt"),
    model: text("model"),
    params: jsonb("params").$type<GenerationParams>(),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    // Soft delete: serving and listing hide the asset immediately; a later
    // sweep deletes the R2 object and only then hard-deletes the row, so the
    // provenance graph of generations that referenced it survives until purge.
    deletedAt: tstz("deleted_at"),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [
    index("asset_organizationId_idx").on(table.organizationId),
    index("asset_projectId_createdAt_idx").on(table.projectId, table.createdAt),
    index("asset_createdBy_idx").on(table.createdBy),
    // The sweeper's index, and it has to cover everything the sweep collects,
    // not just in-flight rows: a tombstoned row waiting for its object to be
    // deleted, and a `failed` one whose bytes may have landed anyway. Still
    // tiny, because a healthy row is `ready` and undeleted, which this
    // excludes.
    index("asset_sweep_idx")
      .on(table.updatedAt)
      .where(sql`${table.deletedAt} is not null or ${table.status} <> 'ready'`),
    check("asset_source_check", sql`${table.source} in ('ai', 'upload')`),
    check("asset_kind_check", sql`${table.kind} in ('image', 'voice', 'music', 'video')`),
    check("asset_status_check", sql`${table.status} in ('pending', 'ready', 'failed')`),
    // An AI asset without a prompt or model is a bug caught at write time.
    check(
      "asset_ai_fields_check",
      sql`${table.source} <> 'ai' or (${table.prompt} is not null and ${table.model} is not null)`
    )
  ]
);

/**
 * Which assets a generation was fed as inputs. A junction table rather than an
 * id array so the links are real foreign keys, the reverse question — which
 * generations used this file — is an indexed lookup, and each edge can say
 * what the input was for. The composite key doubles as the one-input-per-slot
 * rule and permits the same asset in two roles.
 */
export const assetReference = pgTable(
  "asset_reference",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "cascade" }),
    referencedAssetId: uuid("referenced_asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "cascade" }),
    /** Slot the input filled, e.g. 'source_image', 'style_reference'. */
    role: text("role"),
    position: integer("position").default(0).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.position] }),
    index("asset_reference_referencedAssetId_idx").on(table.referencedAssetId)
  ]
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  ownedOrganizations: many(organization),
  invitations: many(invitation),
  ssoProviders: many(ssoProvider),
  projects: many(project)
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id]
  })
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id]
  })
}));

export const organizationRelations = relations(organization, ({ one, many }) => ({
  owner: one(user, {
    fields: [organization.ownerId],
    references: [user.id]
  }),
  members: many(member),
  invitations: many(invitation),
  projects: many(project),
  assets: many(asset)
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id]
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id]
  })
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id]
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id]
  })
}));

export const ssoProviderRelations = relations(ssoProvider, ({ one }) => ({
  user: one(user, {
    fields: [ssoProvider.userId],
    references: [user.id]
  })
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id]
  }),
  creator: one(user, {
    fields: [project.createdBy],
    references: [user.id]
  }),
  assets: many(asset)
}));

export const assetRelations = relations(asset, ({ one, many }) => ({
  organization: one(organization, {
    fields: [asset.organizationId],
    references: [organization.id]
  }),
  project: one(project, {
    fields: [asset.projectId],
    references: [project.id]
  }),
  creator: one(user, {
    fields: [asset.createdBy],
    references: [user.id]
  }),
  /** Inputs this asset was generated from. */
  references: many(assetReference, { relationName: "asset_references" }),
  /** Generations that used this asset as an input. */
  referencedBy: many(assetReference, { relationName: "asset_referenced_by" })
}));

export const assetReferenceRelations = relations(assetReference, ({ one }) => ({
  asset: one(asset, {
    fields: [assetReference.assetId],
    references: [asset.id],
    relationName: "asset_references"
  }),
  referencedAsset: one(asset, {
    fields: [assetReference.referencedAssetId],
    references: [asset.id],
    relationName: "asset_referenced_by"
  })
}));
