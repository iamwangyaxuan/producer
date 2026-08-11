import { relations, sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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

export const organization = pgTable("organization", {
  id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: tstz("created_at").notNull(),
  metadata: text("metadata"),
  personalOwnerId: uuid("personal_owner_id")
    .unique()
    .references(() => user.id, { onDelete: "cascade" })
});

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

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
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

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
  projects: many(project)
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

export const projectRelations = relations(project, ({ one }) => ({
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id]
  }),
  creator: one(user, {
    fields: [project.createdBy],
    references: [user.id]
  })
}));
