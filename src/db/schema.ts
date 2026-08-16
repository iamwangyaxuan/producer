import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
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

/**
 * Raw bytes. `pg-core` has no `bytea` of its own, and the driver speaks
 * `Buffer` on both sides — the copy on the way out is deliberate: node-postgres
 * hands back slices of a pooled buffer, and a `Uint8Array` that merely borrowed
 * one would decode a document the pool had meanwhile reused underneath it.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
  toDriver(value) {
    return Buffer.from(value);
  }
});

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
  banExpires: tstz("ban_expires"),
  /**
   * Who this person is on the billing side. Written by the Stripe plugin the
   * first time they pay for anything, and never by us.
   *
   * It hangs off the user rather than the organization because of the order the
   * purchase happens in: an organization is bought before it exists, so at the
   * moment the customer record is needed there is no organization row to attach
   * it to. The payer is the person; what they bought is named by
   * `subscription.referenceId`.
   */
  stripeCustomerId: text("stripe_customer_id")
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
     * At least 1, because an organization always holds its owner. The value is
     * copied off `subscription.seats` when a purchase completes (see
     * `applyPurchasedOrganization` in `lib/organization.ts`) — the subscription
     * is the billing record, this is the number every runtime check reads, and
     * they are kept as two columns so a seat check never has to know whether
     * billing is reachable. `DEFAULT_SEATS` covers the organizations that were
     * not bought: private workspaces, and anything better-auth's own
     * `/organization/create` endpoint makes.
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

/**
 * A Stripe subscription, mirrored locally. Owned end to end by
 * `@better-auth/stripe` — every column here is one the plugin reads or writes,
 * which is why the names are its names rather than this schema's.
 *
 * `referenceId` is what the subscription was bought *for*, and it holds an
 * organization id. It is deliberately **not** a foreign key: this app sells the
 * organization before it exists, so the row is written while `organization`
 * still has nothing at that id — a constraint here would reject the insert that
 * starts the purchase. What closes the loop instead is `organization_draft`,
 * which reserves the id and records who is allowed to pay against it.
 *
 * `status` carries Stripe's vocabulary verbatim (`incomplete`, `trialing`,
 * `active`, `past_due`, `canceled`, …) and gets no CHECK constraint, unlike the
 * status columns this app owns: the set belongs to Stripe, and a value we have
 * not heard of yet has to be storable rather than rejected at 3am by a webhook.
 */
export const subscription = pgTable(
  "subscription",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    plan: text("plan").notNull(),
    referenceId: text("reference_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    status: text("status").default("incomplete").notNull(),
    periodStart: tstz("period_start"),
    periodEnd: tstz("period_end"),
    trialStart: tstz("trial_start"),
    trialEnd: tstz("trial_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
    cancelAt: tstz("cancel_at"),
    canceledAt: tstz("canceled_at"),
    endedAt: tstz("ended_at"),
    /** How many were paid for — the number `organization.seat` is copied from. */
    seats: integer("seats"),
    billingInterval: text("billing_interval"),
    stripeScheduleId: text("stripe_schedule_id"),
    // Not in the plugin's field list, so the adapter never carries them and
    // they are filled by the database alone: `defaultNow()` on insert, and
    // drizzle's `$onUpdate` on every update the adapter issues through it.
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [
    index("subscription_referenceId_idx").on(table.referenceId),
    // Both are how a webhook finds the row it is about, and neither is unique:
    // a reference accumulates one row per purchase attempt, and Stripe ids are
    // null until the checkout that mints them completes.
    index("subscription_stripeSubscriptionId_idx").on(table.stripeSubscriptionId),
    index("subscription_stripeCustomerId_idx").on(table.stripeCustomerId)
  ]
);

export const ORGANIZATION_DRAFT_STATUSES = ["pending", "completed", "canceled"] as const;

export type OrganizationDraftStatus = (typeof ORGANIZATION_DRAFT_STATUSES)[number];

/**
 * An organization someone has started paying for and that does not exist yet.
 *
 * It exists because of the order this app insists on: seats are bought *before*
 * the organization is created, so the whole checkout has to name a tenant that
 * has no row. `id` is that name — it is minted here and later becomes
 * `organization.id` verbatim, which is what lets `subscription.referenceId`
 * point at the finished organization from the moment the purchase starts,
 * instead of being rewritten afterwards.
 *
 * It is also the authorization record for the checkout. `authorizeReference` in
 * `auth.ts` is handed a reference id and has to answer whether this user may
 * pay against it; for an organization that already exists the answer comes from
 * `member`, and for one that does not, it comes from here.
 *
 * The row survives completion rather than being deleted: it is the only record
 * of what was ordered, so a purchase whose organization failed to materialize
 * is still recoverable from it — and a replayed webhook can tell "already done"
 * from "never happened".
 */
export const organizationDraft = pgTable(
  "organization_draft",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Never `private`: that one is created at sign up and is not for sale. */
    type: text("type").$type<OrganizationType>().notNull(),
    seats: integer("seats").notNull(),
    status: text("status").$type<OrganizationDraftStatus>().default("pending").notNull(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [
    index("organization_draft_userId_idx").on(table.userId),
    check("organization_draft_type_check", sql`${table.type} in ('team', 'enterprise')`),
    check("organization_draft_seats_check", sql`${table.seats} >= 1`),
    check(
      "organization_draft_status_check",
      sql`${table.status} in ('pending', 'completed', 'canceled')`
    )
  ]
);

/* -------------------------------------------------------------------------- */
/* Credits: the prepaid wallet every model call is paid out of                */
/* -------------------------------------------------------------------------- */

/**
 * One wallet per organization.
 *
 * Money in these four tables is an integer count of **micro-dollars** (1e-6
 * USD), and every balance, ledger entry and price is in that unit. Not cents,
 * because a single model call genuinely costs a fraction of one — a thousand
 * characters of speech is a few thousandths of a dollar — and a unit that
 * cannot represent the smallest thing being sold rounds every one of them to
 * either nothing or a whole cent. Not `numeric`, because a wallet is only safe
 * if `balance = balance - x` is exact in one statement; integers give that,
 * while decimals invite a driver to hand back a string and a caller to
 * `parseFloat` it. `bigint` in `number` mode like `asset.sizeBytes`, whose
 * ±2^53 is ±9 billion dollars. Amounts stay in **cents** only where they touch
 * Stripe (`credit_topup.chargeAmount`) — converting once, at that edge, is what
 * keeps a rounding error out of a charge.
 *
 * USD is also the currency the AI Gateway bills us in, which is what makes
 * `usage_event` legible: what a call was sold for and what it cost sit in two
 * columns of one currency, so the margin is a subtraction rather than an
 * exchange rate this app would have to invent and then keep.
 *
 * Per *organization* because that is the thing work happens inside: a project,
 * its canvas and its assets are all org-scoped, so the bill for generating them
 * belongs to the same tenant rather than to whoever happened to press the
 * button. Everyone has a `private` organization of their own, so "top up my own
 * account" is still exactly one wallet away for a solo user. The payer stays a
 * person — Stripe's customer is `user.stripeCustomerId` and the plugin runs
 * with `customerType: "user"` — which is why `credit_topup` names both: an
 * organization is credited, a person is charged.
 *
 * `balance` is materialized rather than summed from `credit_transaction` on
 * every read: a debit has to be one atomic conditional update
 * (`set balance = balance - x where balance >= x`), which is what makes two
 * concurrent generations unable to spend the same last dollar twice. The ledger
 * is the audit trail and must reconcile — `sum(amount) = balance` — but it is
 * not what a charge reads.
 *
 * `restrict` rather than `cascade`, for the reason `asset.organizationId` is:
 * a cascade here would silently burn a balance somebody paid for. Deleting an
 * organization that still holds money has to be a deliberate act that empties
 * the wallet first, and until it is, Postgres refuses — loudly, which is the
 * better of the two failures.
 */
export const creditAccount = pgTable(
  "credit_account",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "restrict" }),
    /** Micro-dollars. Never negative — the CHECK is the last line of that defence. */
    balance: bigint("balance", { mode: "number" }).default(0).notNull(),
    /** Lifetime totals, for the account page. Derived, and never read by a charge. */
    lifetimeToppedUp: bigint("lifetime_topped_up", { mode: "number" }).default(0).notNull(),
    lifetimeSpent: bigint("lifetime_spent", { mode: "number" }).default(0).notNull(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [check("credit_account_balance_check", sql`${table.balance} >= 0`)]
);

export const CREDIT_TRANSACTION_KINDS = ["topup", "usage", "refund", "adjustment"] as const;

export type CreditTransactionKind = (typeof CREDIT_TRANSACTION_KINDS)[number];

/**
 * Every movement of the wallet, signed: `+` puts money in, `-` takes it out.
 *
 * Signed rather than an unsigned amount plus a direction inferred from `kind`,
 * because the one query this table exists to answer — "does the ledger agree
 * with the balance" — is then `sum(amount)` and not a `case` expression that
 * has to be kept in step with the kind list.
 *
 * `referenceId` is what the entry is *about*, and it is the idempotency key:
 * an asset id for `usage` and `refund`, a top-up order id for `topup`. The
 * partial unique index over (`kind`, `referenceId`) is what makes a replayed
 * Stripe webhook, a double-submitted retry and a re-run refund all land once —
 * enforced by the database rather than by remembering to check first.
 */
export const creditTransaction = pgTable(
  "credit_transaction",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    /** The wallet this moved. `restrict`, like the wallet itself. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /**
     * Who did it — the person who pressed generate, or who paid for the top-up.
     *
     * Nullable and `set null` rather than part of the key: an organization's
     * statement has to survive one of its members closing their account, and
     * "somebody who is no longer here spent this" is a truthful line where a
     * missing row would not be. It is display and attribution, never
     * authorization: what a charge is allowed to touch is decided by
     * `organizationId` alone.
     */
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    kind: text("kind").$type<CreditTransactionKind>().notNull(),
    /** Micro-dollars, signed. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    /** The balance this entry produced — what a statement line has to print. */
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    /**
     * Not a foreign key, because it points at two different tables depending on
     * `kind` (and at an `asset` row that the sweep is allowed to hard-delete
     * long before its billing history stops mattering). It is an idempotency
     * key first and a link second.
     */
    referenceId: uuid("reference_id"),
    /** One line, written for the person reading their statement. */
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: tstz("created_at").defaultNow().notNull()
  },
  (table) => [
    index("credit_transaction_organizationId_createdAt_idx").on(
      table.organizationId,
      table.createdAt
    ),
    uniqueIndex("credit_transaction_kind_reference_idx")
      .on(table.kind, table.referenceId)
      .where(sql`${table.referenceId} is not null`),
    check(
      "credit_transaction_kind_check",
      sql`${table.kind} in ('topup', 'usage', 'refund', 'adjustment')`
    ),
    // The sign is part of what a kind *means*, so it is checked rather than
    // trusted: a `usage` row that credited someone would reconcile perfectly
    // and still be wrong.
    check(
      "credit_transaction_amount_check",
      sql`case
            when ${table.kind} in ('topup', 'refund') then ${table.amount} > 0
            when ${table.kind} = 'usage' then ${table.amount} < 0
            else ${table.amount} <> 0
          end`
    )
  ]
);

export const CREDIT_TOPUP_STATUSES = ["pending", "paid", "canceled"] as const;

export type CreditTopupStatus = (typeof CREDIT_TOPUP_STATUSES)[number];

/**
 * One order to put money in the wallet, from the moment it is started until the
 * payment lands.
 *
 * It exists for the same reason `organization_draft` does: the checkout has to
 * name something before the thing it produces exists. Here what it names is the
 * grant — Stripe carries this row's id in the payment's metadata, and the
 * webhook credits *this row's* `creditAmount` rather than whatever amount the
 * event happens to mention.
 *
 * The two amounts are deliberately separate columns in **different units**, and
 * they are what the 5% fee actually is: `creditAmount` is what lands in the
 * wallet (micro-yuan), `chargeAmount` is what the card is charged (fen, which
 * is the unit Stripe quotes CNY in). `feeRateBps` is stamped at order time so a
 * later change to the published rate cannot rewrite what someone already paid.
 */
export const creditTopup = pgTable(
  "credit_topup",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    /** The wallet being credited. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /**
     * Who is paying. Two columns rather than one because they are two different
     * facts: an organization is credited, and a *person* is charged — Stripe's
     * customer is `user.stripeCustomerId`, and a card belongs to somebody.
     * Nullable for the same reason the ledger's is: the order is a financial
     * record of the organization and outlives whoever placed it.
     */
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Micro-dollars credited on success. */
    creditAmount: bigint("credit_amount", { mode: "number" }).notNull(),
    /** Cents actually charged — `creditAmount` plus the fee, in Stripe's unit. */
    chargeAmount: integer("charge_amount").notNull(),
    currency: text("currency").default("usd").notNull(),
    /** Basis points; 500 is the 5% this app charges today. */
    feeRateBps: integer("fee_rate_bps").notNull(),
    status: text("status").$type<CreditTopupStatus>().default("pending").notNull(),
    /** Set as soon as the Checkout Session is minted, so a page can find its order. */
    stripeSessionId: text("stripe_session_id").unique(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    paidAt: tstz("paid_at"),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [
    index("credit_topup_organizationId_createdAt_idx").on(table.organizationId, table.createdAt),
    check("credit_topup_credit_amount_check", sql`${table.creditAmount} > 0`),
    check("credit_topup_charge_amount_check", sql`${table.chargeAmount} > 0`),
    check("credit_topup_fee_rate_check", sql`${table.feeRateBps} >= 0`),
    check("credit_topup_status_check", sql`${table.status} in ('pending', 'paid', 'canceled')`)
  ]
);

/**
 * An organization's own AI Gateway key, encrypted.
 *
 * Bring-your-own-key is a *billing* decision before it is a technical one: an
 * organization that supplies its own key has its generations billed by Vercel
 * directly, so this app stops charging its wallet for them. That is why the key
 * sits at the organization and is set by the roles that already control
 * spending, rather than per person — one member's card silently paying for
 * another member's generations is the outcome nobody would have asked for.
 *
 * A table of its own rather than a column on `organization`, for two reasons.
 * `organization` belongs to better-auth, and a secret riding along in a row
 * that half the app selects is one careless `select()` away from a response
 * body. And a key has a lifecycle a column does not model well — verified when
 * it arrives, replaced, removed — which is what the timestamps here are for.
 *
 * `cascade`, unlike the credit tables: a key is not money, and an organization
 * that goes should take its secrets with it rather than leave them behind.
 */
export const organizationGatewayKey = pgTable("organization_gateway_key", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /**
   * AES-GCM ciphertext, base64. Encrypted rather than stored as given, because
   * this is a live credential for somebody else's account: a database dump, a
   * log of a query, or a backup restored somewhere less careful should not be
   * enough to spend their money. See `server/generation/gateway-key.ts` for the
   * key derivation and for what rotating `BETTER_AUTH_SECRET` costs.
   */
  ciphertext: text("ciphertext").notNull(),
  /** The 12-byte nonce that ciphertext was sealed with, base64. Never reused. */
  iv: text("iv").notNull(),
  /**
   * The last few characters, in clear, so the settings page can show *which*
   * key is installed without ever decrypting one. Enough to recognise, not
   * enough to use.
   */
  preview: text("preview").notNull(),
  /** Who installed it. `set null`, so the key outlives their account. */
  createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
  /**
   * When the Gateway last confirmed this key works. Set on save, because a key
   * is verified before it is stored — a rejected credential accepted into the
   * database would turn every generation in the organization into a failure
   * with no obvious cause.
   */
  verifiedAt: tstz("verified_at").notNull(),
  createdAt: tstz("created_at").defaultNow().notNull(),
  updatedAt: tstz("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull()
});

/** Whose AI Gateway credentials a call used — ours, or the organization's own. */
export const GATEWAY_KEY_SOURCES = ["system", "own"] as const;

export type GatewayKeySource = (typeof GATEWAY_KEY_SOURCES)[number];

export const USAGE_EVENT_STATUSES = ["succeeded", "failed"] as const;

export type UsageEventStatus = (typeof USAGE_EVENT_STATUSES)[number];

/** What the call was for. `generation` is the media itself; `title` names it. */
export const USAGE_EVENT_PURPOSES = ["generation", "title"] as const;

export type UsageEventPurpose = (typeof USAGE_EVENT_PURPOSES)[number];

/**
 * One row per request that left this app for the AI Gateway.
 *
 * Separate from `credit_transaction` because they count different things and
 * one is not derivable from the other: a single generation is **one** charge and
 * **two** Gateway calls (the media, and the small language model that names
 * it), while a generation on a model the Gateway does not serve is zero calls
 * and zero charges. Folding the calls into the ledger would either invent
 * zero-amount money movements or lose the naming call entirely.
 *
 * `chargedAmount` is what the wallet was actually debited *for this call*, and
 * `upstreamCost` is what the Gateway said the call cost us. Both are
 * micro-dollars, so the margin on any slice of traffic is one subtraction —
 * which is the whole reason both are here, and a large part of why the wallet
 * is denominated in the currency the Gateway bills in.
 */
export const usageEvent = pgTable(
  "usage_event",
  {
    id: uuid("id").primaryKey().default(sql.raw(generate_id_fun)),
    /** The wallet that paid — the axis every report on this table groups by. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /** Who asked for it. Attribution, and nullable for the ledger's reason. */
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => project.id, { onDelete: "set null" }),
    assetId: uuid("asset_id").references(() => asset.id, { onDelete: "set null" }),
    /** The charge that paid for this call, when one did. */
    transactionId: uuid("transaction_id").references(() => creditTransaction.id, {
      onDelete: "set null"
    }),
    purpose: text("purpose").$type<UsageEventPurpose>().notNull(),
    /** Null for the naming call, which produces text rather than media. */
    modality: text("modality").$type<AssetKind>(),
    /** Catalogue id, e.g. `veo-3.1-generate-preview`. */
    model: text("model").notNull(),
    /** What was actually sent to the Gateway, e.g. `google/veo-3.1-generate-001`. */
    gatewayModel: text("gateway_model"),
    status: text("status").$type<UsageEventStatus>().notNull(),
    error: text("error"),
    /** What was billed by: images, seconds, thousands of characters, tokens. */
    unit: text("unit"),
    quantity: doublePrecision("quantity"),
    /**
     * Whose credentials the call went out on.
     *
     * Recorded rather than inferred from `chargedAmount`, because zero has two
     * different meanings — a call on the organization's own key, and a call
     * that was refunded — and a usage report that cannot tell those apart is
     * the one place somebody would go to ask exactly that.
     */
    keySource: text("key_source").$type<GatewayKeySource>().notNull().default("system"),
    /** Micro-dollars taken from the wallet for this call; 0 when it was free. */
    chargedAmount: bigint("charged_amount", { mode: "number" }).default(0).notNull(),
    /**
     * What the Gateway said the call cost us, straight from its own report and
     * in the same unit as the column above it — the Gateway bills in USD, which
     * is why this app's wallet is in USD too. Null when it reported no cost.
     */
    upstreamCost: bigint("upstream_cost", { mode: "number" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    /** The provider metadata the cost was read out of, kept for disputes. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: tstz("created_at").defaultNow().notNull()
  },
  (table) => [
    index("usage_event_organizationId_createdAt_idx").on(table.organizationId, table.createdAt),
    index("usage_event_userId_createdAt_idx").on(table.userId, table.createdAt),
    index("usage_event_assetId_idx").on(table.assetId),
    check("usage_event_status_check", sql`${table.status} in ('succeeded', 'failed')`),
    check("usage_event_key_source_check", sql`${table.keySource} in ('system', 'own')`),
    check("usage_event_purpose_check", sql`${table.purpose} in ('generation', 'title')`)
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
 * The project's canvas, as one Yjs update.
 *
 * The document is a CRDT, so what is stored is the encoded state rather than
 * rows per node: re-encoding on every save also garbage-collects everything
 * deleted, which is why a canvas edited for months stays the size of what is
 * currently on it. Keeping it whole is what preserves the delete tombstones —
 * projecting the nodes into relational rows and rebuilding the document from
 * them would lose the record that a node was ever deleted, and a client still
 * holding the old node would push it straight back.
 *
 * It lives here rather than in the Durable Object's own SQLite so that one
 * database holds everything the app owns: `pg_dump` takes the canvases with
 * it, a restore lands them at the same point in time as the projects they
 * belong to, and the row goes when the project does — DO storage is reachable
 * only through the object itself, cannot be enumerated, and would have to be
 * backed up and collected by hand.
 *
 * One row, not chunks: the 1 MB splitting the DO version needed was working
 * around SQLite's 2 MB ceiling per value, and `bytea` (TOASTed past ~2 KB, up
 * to 1 GB) has no such cliff. Which also makes the save a single upsert —
 * atomic replacement without a transaction around a delete and re-insert.
 */
export const canvasSnapshot = pgTable("canvas_snapshot", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => project.id, { onDelete: "cascade" }),
  content: bytea("content").notNull(),
  savedAt: tstz("saved_at").defaultNow().notNull()
});

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
    /**
     * What to call this file — the name a person reads, and the one its URL
     * and download carry. An upload keeps the name it arrived with (minus the
     * extension, which is re-derived from the stored type); a generation gets
     * a short phrase summarizing its prompt, written by a model because
     * nothing mechanical turns "a photo of a dog running on grass" into
     * "running dog".
     *
     * Nullable, and every reader falls back — see `assetTitle` — because a
     * generation whose naming call failed is still a perfectly good asset.
     */
    title: text("title"),
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

/**
 * The stand-in Stripe account: every object the fake backend in
 * `server/billing/fake-stripe.ts` has handed out, exactly as Stripe's API would
 * have serialized it.
 *
 * It is a table rather than a module-level map because a checkout outlives the
 * request that created it — the session is minted by one request, read by the
 * page the browser lands on, and settled by a third — and Worker isolates share
 * no memory across any of those. Postgres is the only thing all three can see.
 *
 * `id` is Stripe's own id string (`cus_…`, `cs_…`, `sub_…`), not a uuid, which
 * is the point: these values are handed to the plugin, stored in
 * `subscription.stripeCustomerId`, and echoed back on the next request, so they
 * have to look and behave exactly like the real ones.
 *
 * **This whole table is scaffolding.** Point `STRIPE_SECRET_KEY` at a real
 * account and nothing reads it again; it can then be dropped in one migration.
 */
export const stripeMockObject = pgTable(
  "stripe_mock_object",
  {
    id: text("id").primaryKey(),
    /** Stripe's own discriminator: `customer`, `checkout.session`, `subscription`. */
    object: text("object").notNull(),
    /**
     * Lifted out of `data` because it is the one field the fake backend filters
     * on — `subscriptions.list({ customer })` is on the upgrade path — and a
     * jsonb expression index for a single key is more machinery than a column.
     */
    customerId: text("customer_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: tstz("created_at").defaultNow().notNull(),
    updatedAt: tstz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull()
  },
  (table) => [index("stripe_mock_object_object_customerId_idx").on(table.object, table.customerId)]
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  ownedOrganizations: many(organization),
  invitations: many(invitation),
  ssoProviders: many(ssoProvider),
  projects: many(project),
  organizationDrafts: many(organizationDraft),
  /** Money this person moved, in whichever organization they moved it in. */
  creditTransactions: many(creditTransaction),
  creditTopups: many(creditTopup),
  usageEvents: many(usageEvent)
}));

export const organizationGatewayKeyRelations = relations(organizationGatewayKey, ({ one }) => ({
  organization: one(organization, {
    fields: [organizationGatewayKey.organizationId],
    references: [organization.id]
  })
}));

export const creditAccountRelations = relations(creditAccount, ({ one }) => ({
  organization: one(organization, {
    fields: [creditAccount.organizationId],
    references: [organization.id]
  })
}));

export const creditTransactionRelations = relations(creditTransaction, ({ one, many }) => ({
  organization: one(organization, {
    fields: [creditTransaction.organizationId],
    references: [organization.id]
  }),
  user: one(user, {
    fields: [creditTransaction.userId],
    references: [user.id]
  }),
  /** The Gateway calls this charge paid for — usually one, two for a generation. */
  usageEvents: many(usageEvent)
}));

export const creditTopupRelations = relations(creditTopup, ({ one }) => ({
  organization: one(organization, {
    fields: [creditTopup.organizationId],
    references: [organization.id]
  }),
  user: one(user, {
    fields: [creditTopup.userId],
    references: [user.id]
  })
}));

export const usageEventRelations = relations(usageEvent, ({ one }) => ({
  user: one(user, {
    fields: [usageEvent.userId],
    references: [user.id]
  }),
  organization: one(organization, {
    fields: [usageEvent.organizationId],
    references: [organization.id]
  }),
  project: one(project, {
    fields: [usageEvent.projectId],
    references: [project.id]
  }),
  asset: one(asset, {
    fields: [usageEvent.assetId],
    references: [asset.id]
  }),
  transaction: one(creditTransaction, {
    fields: [usageEvent.transactionId],
    references: [creditTransaction.id]
  })
}));

/**
 * `subscription` gets none of these on purpose: its only link to the rest of the
 * schema is `referenceId`, which is a plain string precisely because the row it
 * names does not exist yet when the subscription is written. Declaring a
 * relation over a column that is not a foreign key would describe a join
 * Postgres cannot guarantee.
 */
export const organizationDraftRelations = relations(organizationDraft, ({ one }) => ({
  user: one(user, {
    fields: [organizationDraft.userId],
    references: [user.id]
  })
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
  assets: many(asset),
  creditAccount: one(creditAccount),
  gatewayKey: one(organizationGatewayKey),
  creditTransactions: many(creditTransaction),
  creditTopups: many(creditTopup),
  usageEvents: many(usageEvent)
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
  assets: many(asset),
  canvas: one(canvasSnapshot)
}));

export const canvasSnapshotRelations = relations(canvasSnapshot, ({ one }) => ({
  project: one(project, {
    fields: [canvasSnapshot.projectId],
    references: [project.id]
  })
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
