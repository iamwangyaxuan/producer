import { and, desc, eq, ne, sql } from "drizzle-orm";

import { getDB, schema } from "#/db";
import type { CreditTransactionKind } from "#/db/schema";

/**
 * The wallet: the only code that moves money.
 *
 * A leaf module on purpose — it imports the database and nothing else. `auth.ts`
 * reaches it through the Stripe event handler, the generation path reaches it
 * from a server function, and neither can drag the other in behind it.
 *
 * Every function here is addressed by **organization**, never by user. The
 * wallet belongs to the tenant the work happens in; who pressed the button is
 * recorded alongside for attribution and is never what decides whose money is
 * spent. Deciding that a caller may act for an organization happens one layer
 * up, in `lib/credits.ts` and in the project access gate — this module trusts
 * the id it is handed, exactly as the rest of the server layer does.
 *
 * Two rules hold everything here together:
 *
 * - **A balance only ever changes inside a conditional update.** Never read,
 *   decide, then write: two generations submitted at the same instant would
 *   both read the same last dollar and both spend it. `where balance >= amount`
 *   makes the check and the change one statement, and the loser gets zero rows
 *   back rather than an overdraft.
 * - **Every entry carries the id of the thing it is about, and the database
 *   refuses a second one.** The unique index over (`kind`, `referenceId`) is
 *   what makes a redelivered Stripe webhook, a double-clicked retry and a
 *   re-run refund all land exactly once — so none of the callers below has to
 *   remember to check first.
 */

export class InsufficientCredits extends Error {
  constructor(
    readonly required: number,
    readonly balance: number
  ) {
    super("Not enough credits.");
  }
}

/** Postgres' unique-violation code, which is how "already applied" arrives here. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether this is the index refusing a duplicate — the signal the whole
 * idempotency story rests on.
 *
 * The chain walk is not defensive coding for its own sake. Drizzle does not
 * rethrow the driver's error; it wraps it in a `DrizzleQueryError` carrying the
 * SQL and the parameters, with the original hanging off `cause`. Reading `code`
 * off the top-level object therefore always answers `undefined`, and a check
 * written that way looks correct, passes review, and quietly turns every
 * redelivered webhook into a 500 — which is exactly what it did here before the
 * replay was tried.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let cursor = error; cursor instanceof Error || typeof cursor === "object";) {
    if (cursor === null) return false;

    if ((cursor as { code?: unknown }).code === UNIQUE_VIOLATION) return true;

    const next = (cursor as { cause?: unknown }).cause;
    if (next === undefined || next === cursor) return false;

    cursor = next;
  }

  return false;
}

type DB = ReturnType<typeof getDB>;

/**
 * The wallet row, created on first sight.
 *
 * Not created with the organization: most never generate anything, and a row
 * per tenant that only ever holds zero is a table to migrate for no reason. `on
 * conflict do nothing` rather than a read-then-insert, because two tabs opening
 * the billing page at once is an ordinary sequence.
 */
export async function ensureCreditAccount(organizationId: string, db: DB = getDB()) {
  await db.insert(schema.creditAccount).values({ organizationId }).onConflictDoNothing();

  const [account] = await db
    .select()
    .from(schema.creditAccount)
    .where(eq(schema.creditAccount.organizationId, organizationId))
    .limit(1);

  return account;
}

export interface CreditBalance {
  balance: number;
  lifetimeToppedUp: number;
  lifetimeSpent: number;
}

/**
 * What is in the wallet. Zero for an account that has never had one, which is
 * the truth rather than a placeholder — and answering it without writing a row
 * is what keeps a page view from being a write.
 */
export async function readBalance(
  organizationId: string,
  db: DB = getDB()
): Promise<CreditBalance> {
  const [account] = await db
    .select({
      balance: schema.creditAccount.balance,
      lifetimeToppedUp: schema.creditAccount.lifetimeToppedUp,
      lifetimeSpent: schema.creditAccount.lifetimeSpent
    })
    .from(schema.creditAccount)
    .where(eq(schema.creditAccount.organizationId, organizationId))
    .limit(1);

  return account ?? { balance: 0, lifetimeToppedUp: 0, lifetimeSpent: 0 };
}

interface LedgerInput {
  /** Whose wallet. This, and only this, decides what is spent. */
  organizationId: string;
  /** Who did it — recorded on the entry, never consulted for permission. */
  userId?: string | null;
  kind: CreditTransactionKind;
  /** Micro-dollars, always positive — the direction comes from `kind`. */
  amount: number;
  referenceId?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface LedgerEntry {
  transactionId: string;
  amount: number;
  balanceAfter: number;
}

/**
 * Takes money out, or answers that there was not enough.
 *
 * The conditional update is the whole mechanism. `balance >= amount` in the
 * `where` means Postgres decides, under the row lock it takes anyway, whether
 * this debit is affordable — and a caller that lost that decision gets zero
 * rows rather than a negative balance to notice later.
 *
 * The insert that follows shares the transaction, so a ledger that disagrees
 * with the balance is not a state this can reach. If the entry is a duplicate —
 * the same asset charged twice — the whole thing rolls back and the existing
 * entry is returned instead, which is what makes a retried call safe rather
 * than expensive.
 */
export async function debit(input: LedgerInput): Promise<LedgerEntry> {
  if (input.amount <= 0) throw new Error("A debit must be positive.");

  const db = getDB();

  await ensureCreditAccount(input.organizationId, db);

  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .update(schema.creditAccount)
        .set({
          balance: sql`${schema.creditAccount.balance} - ${input.amount}`,
          lifetimeSpent: sql`${schema.creditAccount.lifetimeSpent} + ${input.amount}`,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.creditAccount.organizationId, input.organizationId),
            sql`${schema.creditAccount.balance} >= ${input.amount}`
          )
        )
        .returning({ balance: schema.creditAccount.balance });

      // Thrown with a placeholder balance and rebuilt below: reading it here
      // would read it from inside the transaction that is about to roll back,
      // and the number worth telling someone is the one their wallet actually
      // holds afterwards.
      if (!account) throw new InsufficientCredits(input.amount, 0);

      const [entry] = await tx
        .insert(schema.creditTransaction)
        .values({
          organizationId: input.organizationId,
          userId: input.userId ?? null,
          kind: input.kind,
          // Stored signed, so reconciling the ledger against the balance is a
          // `sum` and not a `case` that has to know the kind list.
          amount: -input.amount,
          balanceAfter: account.balance,
          referenceId: input.referenceId ?? null,
          description: input.description,
          metadata: input.metadata
        })
        .returning({ id: schema.creditTransaction.id });

      return { transactionId: entry.id, amount: -input.amount, balanceAfter: account.balance };
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) {
      throw new InsufficientCredits(
        input.amount,
        (await readBalance(input.organizationId, db)).balance
      );
    }

    if (!isUniqueViolation(error)) throw error;

    // Already charged for this exact thing. The transaction above rolled the
    // balance change back with it, so the wallet still reflects the first
    // charge and nothing else has to be undone.
    const existing = await findEntry(input.kind, input.referenceId ?? null, db);

    if (!existing) throw error;

    return existing;
  }
}

/**
 * Puts money in. Same shape as {@link debit} and the same idempotency, which is
 * what a webhook that Stripe redelivers needs from it.
 */
export async function credit(input: LedgerInput): Promise<LedgerEntry> {
  if (input.amount <= 0) throw new Error("A credit must be positive.");

  const db = getDB();

  await ensureCreditAccount(input.organizationId, db);

  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .update(schema.creditAccount)
        .set({
          balance: sql`${schema.creditAccount.balance} + ${input.amount}`,
          // A refund is money coming back rather than money paid in, so only a
          // real top-up moves the lifetime figure the account page shows.
          ...(input.kind === "topup"
            ? {
                lifetimeToppedUp: sql`${schema.creditAccount.lifetimeToppedUp} + ${input.amount}`
              }
            : {
                lifetimeSpent: sql`greatest(0, ${schema.creditAccount.lifetimeSpent} - ${input.amount})`
              }),
          updatedAt: new Date()
        })
        .where(eq(schema.creditAccount.organizationId, input.organizationId))
        .returning({ balance: schema.creditAccount.balance });

      if (!account) throw new Error("That wallet does not exist.");

      const [entry] = await tx
        .insert(schema.creditTransaction)
        .values({
          organizationId: input.organizationId,
          userId: input.userId ?? null,
          kind: input.kind,
          amount: input.amount,
          balanceAfter: account.balance,
          referenceId: input.referenceId ?? null,
          description: input.description,
          metadata: input.metadata
        })
        .returning({ id: schema.creditTransaction.id });

      return { transactionId: entry.id, amount: input.amount, balanceAfter: account.balance };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const existing = await findEntry(input.kind, input.referenceId ?? null, db);

    if (!existing) throw error;

    return existing;
  }
}

async function findEntry(
  kind: CreditTransactionKind,
  referenceId: string | null,
  db: DB
): Promise<LedgerEntry | null> {
  if (!referenceId) return null;

  const [row] = await db
    .select({
      id: schema.creditTransaction.id,
      amount: schema.creditTransaction.amount,
      balanceAfter: schema.creditTransaction.balanceAfter
    })
    .from(schema.creditTransaction)
    .where(
      and(
        eq(schema.creditTransaction.kind, kind),
        eq(schema.creditTransaction.referenceId, referenceId)
      )
    )
    .limit(1);

  return row ? { transactionId: row.id, amount: row.amount, balanceAfter: row.balanceAfter } : null;
}

/**
 * Gives back what a generation was charged, because it did not produce
 * anything.
 *
 * The amount is read off the charge rather than recomputed: between the debit
 * and the failure the catalogue could have been redeployed with a different
 * price, and a refund that does not match its charge is worse than no refund —
 * it silently mints or destroys credit. Reading the row makes the pair sum to
 * zero by construction.
 *
 * `null` when there was nothing to refund, which is the ordinary case: a
 * generation on a model the Gateway does not serve was never charged.
 */
export async function refundCharge(
  organizationId: string,
  referenceId: string,
  description: string,
  userId?: string | null
) {
  const charge = await findEntry("usage", referenceId, getDB());

  if (!charge) return null;

  return await credit({
    organizationId,
    userId,
    kind: "refund",
    amount: Math.abs(charge.amount),
    referenceId,
    description,
    metadata: { chargeId: charge.transactionId }
  });
}

export interface StatementEntry {
  id: string;
  kind: CreditTransactionKind;
  amount: number;
  balanceAfter: number;
  description: string | null;
  /** Who moved it. Null once that account is gone, or for machine entries. */
  actor: string | null;
  createdAt: Date;
}

/**
 * The statement, newest first.
 *
 * The actor is joined in because this is a *shared* wallet: on a team, "what
 * was this spent on" is only half the question and "by whom" is the other half.
 * A left join, so an entry whose person has since left still lists.
 */
export async function listTransactions(
  organizationId: string,
  limit: number
): Promise<StatementEntry[]> {
  return await getDB()
    .select({
      id: schema.creditTransaction.id,
      kind: schema.creditTransaction.kind,
      amount: schema.creditTransaction.amount,
      balanceAfter: schema.creditTransaction.balanceAfter,
      description: schema.creditTransaction.description,
      actor: schema.user.name,
      createdAt: schema.creditTransaction.createdAt
    })
    .from(schema.creditTransaction)
    .leftJoin(schema.user, eq(schema.user.id, schema.creditTransaction.userId))
    .where(eq(schema.creditTransaction.organizationId, organizationId))
    .orderBy(desc(schema.creditTransaction.createdAt))
    .limit(limit);
}

export interface UsageSummaryRow {
  model: string;
  modality: string | null;
  /** Whose key these ran on — the row is grouped by it, so it never mixes. */
  keySource: string;
  calls: number;
  /** Micro-dollars billed for these calls. */
  charged: number;
  /** Micro-dollars the Gateway said they cost us, when it said. */
  upstreamCost: number | null;
}

/**
 * What has been called, and what it cost on both sides.
 *
 * This is the report the whole `usage_event` table exists for: one row per
 * model, our revenue next to our cost. `failed` calls are counted too — they
 * happened, and a model that fails half the time is exactly what a report like
 * this should make visible.
 *
 * Grouped by `keySource` as well, so calls the organization made on its own key
 * never average into the ones we billed: those two kinds of row mean different
 * things and a combined "charged" figure across them is a number with no
 * referent.
 */
export async function summarizeUsage(
  organizationId: string,
  days: number
): Promise<UsageSummaryRow[]> {
  const rows = await getDB()
    .select({
      model: schema.usageEvent.model,
      modality: schema.usageEvent.modality,
      keySource: schema.usageEvent.keySource,
      calls: sql<number>`count(*)::int`,
      // `::text`, then `Number` below. `sum()` over a bigint column is a
      // `numeric`, which node-postgres hands back as a **string** rather than a
      // number — typing it `sql<number>` would compile and then put `"12000"`
      // on the page. Casting to text says out loud that the conversion is ours.
      charged: sql<string>`coalesce(sum(${schema.usageEvent.chargedAmount}), 0)::text`,
      upstreamCost: sql<string | null>`sum(${schema.usageEvent.upstreamCost})::text`
    })
    .from(schema.usageEvent)
    .where(
      and(
        eq(schema.usageEvent.organizationId, organizationId),
        sql`${schema.usageEvent.createdAt} > now() - make_interval(days => ${days})`
      )
    )
    .groupBy(schema.usageEvent.model, schema.usageEvent.modality, schema.usageEvent.keySource)
    .orderBy(desc(sql`coalesce(sum(${schema.usageEvent.chargedAmount}), 0)`));

  return rows.map((row) => ({
    ...row,
    charged: Number(row.charged),
    upstreamCost: row.upstreamCost === null ? null : Number(row.upstreamCost)
  }));
}

/* -------------------------------------------------------------------------- */
/* Top-ups                                                                    */
/* -------------------------------------------------------------------------- */

export interface AppliedTopup {
  topupId: string;
  organizationId: string;
  credited: number;
  balanceAfter: number;
}

/**
 * A paid top-up turned into credit.
 *
 * Called from the Stripe webhook, so it has to be safe to run any number of
 * times — Stripe redelivers, and the local stand-in delivers synchronously from
 * a button someone can press twice. Both are covered the same way: the ledger's
 * unique index refuses a second `topup` entry for this order id, and the status
 * flip is guarded on the status it is moving away from.
 *
 * The amount comes from **this row**, never from the event. What the event
 * carries is what was charged (including our fee); what lands in the wallet is
 * what was ordered. Reading the credit off the payment would quietly hand
 * everyone their handling fee back as spendable balance.
 *
 * `null` for an id with no order behind it — a legitimate answer for a webhook
 * handler, which sees every event on the account including ones about payments
 * this app did not start.
 */
export async function applyPaidTopup(input: {
  topupId: string;
  paymentIntentId?: string | null;
  /** Cents actually received, when the event says. Refused if short. */
  amountReceivedCents?: number | null;
}): Promise<AppliedTopup | null> {
  const db = getDB();

  const [order] = await db
    .select()
    .from(schema.creditTopup)
    .where(eq(schema.creditTopup.id, input.topupId))
    .limit(1);

  if (!order) return null;

  if (
    typeof input.amountReceivedCents === "number" &&
    input.amountReceivedCents < order.chargeAmount
  ) {
    // A partial payment is not this function's to interpret. Refusing loudly
    // leaves the order pending and the money visible in Stripe, which is a
    // person's problem to resolve rather than a balance to guess at.
    throw new Error(
      `Top-up ${order.id} received ${input.amountReceivedCents} of ${order.chargeAmount} cents.`
    );
  }

  const entry = await credit({
    organizationId: order.organizationId,
    userId: order.userId,
    kind: "topup",
    amount: order.creditAmount,
    referenceId: order.id,
    description: "Account top-up",
    metadata: {
      chargeCents: order.chargeAmount,
      currency: order.currency,
      feeRateBps: order.feeRateBps
    }
  });

  await db
    .update(schema.creditTopup)
    .set({
      status: "paid",
      paidAt: new Date(),
      stripePaymentIntentId: input.paymentIntentId ?? order.stripePaymentIntentId
    })
    .where(
      and(
        eq(schema.creditTopup.id, order.id),
        // Anything but `paid`, which covers two cases at once: a replay finds
        // the row already paid and changes nothing — keeping `paidAt` the
        // moment the money arrived rather than the moment Stripe last retried —
        // and an order somebody walked away from locally and then paid for
        // anyway still lands, because they did pay.
        ne(schema.creditTopup.status, "paid")
      )
    );

  return {
    topupId: order.id,
    organizationId: order.organizationId,
    credited: order.creditAmount,
    balanceAfter: entry.balanceAfter
  };
}
