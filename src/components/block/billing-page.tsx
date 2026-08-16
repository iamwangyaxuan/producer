import { useQueryErrorResetBoundary, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import {
  CARD_CLASS,
  DashboardPage,
  INPUT_CLASS,
  PageCard,
  PageErrorPanel,
  SECTION_TITLE_CLASS
} from "#/components/block/dashboard-page";
import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import {
  statementQueryOptions,
  usageSummaryQueryOptions,
  useStartTopup,
  walletQueryOptions
} from "#/lib/credits";
import type { StatementLine, UsageSummaryRow, WalletSummary } from "#/lib/credits";
import { gatewayKeyQueryOptions, useRemoveGatewayKey, useSaveGatewayKey } from "#/lib/gateway-key";
import { formatUsd, MICRO_PER_DOLLAR } from "#/lib/money";
import { parseTopupAmount, quoteTopup, TOPUP_FEE_BPS, TOPUP_PRESETS } from "#/lib/pricing";

/*
 * The wallet: what is in it, how to put more in, and what has come out.
 *
 * One page rather than three, because the three questions are only ever asked
 * together — nobody looks at a statement without wanting to know the balance,
 * and nobody tops up without having just seen one of the two. The top-up
 * control sits directly under the balance for the same reason the seat count
 * sits next to the invite button on the members page: the number and the thing
 * you do about the number belong on the same screen.
 */

const PRESET_CLASS = [
  "cursor-pointer rounded-[12px] border px-3 py-2 text-sm transition-colors",
  "outline-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2"
].join(" ");

const ROW_CLASS = "flex items-baseline justify-between gap-4 py-2 text-sm";

/** How a ledger entry is introduced when it has no description of its own. */
const KIND_LABEL = {
  topup: "Top-up",
  usage: "Generation",
  refund: "Refund",
  adjustment: "Adjustment"
} as const;

export interface BillingPageProps {
  justPaid: boolean;
  /**
   * The organization the *client* currently believes in — it keys the cache and
   * never travels to the server, which scopes every read from the session. Same
   * contract as the projects page.
   */
  activeOrganizationId: string | null | undefined;
}

export function BillingPage({ justPaid, activeOrganizationId }: BillingPageProps) {
  const { data: wallet } = useSuspenseQuery(walletQueryOptions(activeOrganizationId));

  return (
    <DashboardPage
      title="Credits"
      description={
        wallet.organizationName
          ? `Shared by everyone in ${wallet.organizationName}. Every generation is paid for out of this balance, at the price shown before you send it.`
          : "Every generation is paid for out of this balance, at the price shown before you send it."
      }
    >
      {justPaid ? (
        // Shown on arrival from a completed payment. With a real Stripe
        // account the credit is added by a webhook that may land a moment
        // after the redirect, so this says the payment succeeded rather than
        // claiming a balance that might still be catching up.
        <p
          role="status"
          className="mt-6 flex items-start gap-2 rounded-[12px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.05)] p-3 text-sm text-neutral-300"
        >
          <Icon name="check_circle" className="mt-px shrink-0 text-base text-neutral-400" />
          <span>Payment received. Your credit appears here as soon as it is confirmed.</span>
        </p>
      ) : null}

      <div
        className={
          wallet.canManage
            ? "mt-6 grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
            : "mt-6 grid grid-cols-1 gap-4"
        }
      >
        <BalanceCard wallet={wallet} />
        {wallet.canManage ? <TopupCard /> : null}
      </div>

      {/*
       * Absent rather than disabled for a plain member, the same way the
       * sidebar drops the members group: adding money and reading who spent
       * it are the owner's and admin's, on the rule the seat subscription
       * already follows — members use what has been paid for, they do not
       * change what is being paid for. The balance above stays visible to
       * everyone, because it is the number behind every refusal they can hit.
       */}
      {wallet.canManage ? (
        <ManagedSections activeOrganizationId={activeOrganizationId} />
      ) : (
        <p className="mt-4 text-sm text-neutral-400">
          Ask an owner or an admin of this organization to add credit.
        </p>
      )}
    </DashboardPage>
  );
}

/**
 * The two reads a plain member is not allowed to make, behind one boundary.
 *
 * Split out so their queries are never even mounted for someone the server
 * would refuse — a suspended component that throws on every render is a worse
 * way to say "not for you" than not rendering it.
 */
function ManagedSections({
  activeOrganizationId
}: {
  activeOrganizationId: string | null | undefined;
}) {
  const { data: usage } = useSuspenseQuery(usageSummaryQueryOptions(activeOrganizationId));
  const { data: statement } = useSuspenseQuery(statementQueryOptions(activeOrganizationId));

  return (
    <>
      <GatewayKeyCard activeOrganizationId={activeOrganizationId} />
      <UsageCard rows={usage} />
      <StatementCard lines={statement} />
    </>
  );
}

/**
 * Bringing your own AI Gateway key.
 *
 * It sits on the billing page and not in some technical corner because that is
 * what it is: installing a key moves who pays for every generation in the
 * organization from this balance to a Vercel invoice. The card says so in those
 * words, above the field, because it is the consequence somebody is agreeing to
 * and it is not recoverable by guessing.
 *
 * There is no "show key" and no editing in place — the server never sends one
 * back. Replacing means pasting a new one, which is also the only operation
 * that can prove the new key works before the old one is dropped.
 */
function GatewayKeyCard({
  activeOrganizationId
}: {
  activeOrganizationId: string | null | undefined;
}) {
  const inputId = useId();
  const { data: key } = useSuspenseQuery(gatewayKeyQueryOptions(activeOrganizationId));
  const [draft, setDraft] = useState("");

  const save = useSaveGatewayKey();
  const remove = useRemoveGatewayKey();

  const busy = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;

  function submit() {
    if (draft.trim() === "") return;

    // Cleared only on success: a rejected key leaves what was typed where it
    // is, because the usual reason for a rejection is a paste that lost a
    // character and retyping the whole thing is the wrong penalty for that.
    save.mutate({ apiKey: draft.trim() }, { onSuccess: () => setDraft("") });
  }

  return (
    <PageCard className="mt-4">
      <p className={SECTION_TITLE_CLASS}>Your own AI Gateway key</p>
      <p className="mt-1 text-xs text-neutral-400">
        Add a Vercel AI Gateway key and every generation in this organization goes out on it —
        billed to your Vercel account instead of to the balance above.
      </p>

      {key.installed ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.05)] p-3">
          <div className="min-w-0">
            <p className="text-foreground text-sm">
              {/* Four characters is enough to tell two keys apart and not
                  enough to use one. The server has no way to show more. */}
              <span className="tabular-nums">••••{key.installed.preview}</span>
            </p>
            <p className="text-xs text-neutral-500">
              Verified {new Date(key.installed.verifiedAt).toLocaleString()}
            </p>
          </div>
          <Button variant="secondary" onClick={() => remove.mutate()} pending={remove.isPending}>
            Remove
          </Button>
        </div>
      ) : null}

      <div className="mt-3">
        <label htmlFor={inputId} className="text-xs text-neutral-400">
          {key.installed ? "Replace it with another key" : "Paste your key"}
        </label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <input
            id={inputId}
            // `password`, so it is not left legible on a shared screen or
            // captured by a screenshot taken for some other reason.
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="vck_…"
            disabled={busy}
            className={`${INPUT_CLASS} min-w-0 flex-1`}
          />
          <Button onClick={submit} disabled={draft.trim() === ""} pending={save.isPending}>
            {key.installed ? "Replace" : "Use my key"}
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-neutral-500">
          It is checked against the Gateway before it is saved, encrypted at rest, and never shown
          again.
        </p>
      </div>

      {error ? (
        // Verbatim: everything that reaches here is either the Gateway refusing
        // the key or a refusal to manage billing, and both were written for the
        // person holding the key. See `saveGatewayKeyFn` for what guarantees
        // that.
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error.message}
        </p>
      ) : null}
    </PageCard>
  );
}

function BalanceCard({ wallet }: { wallet: WalletSummary }) {
  return (
    <div className={CARD_CLASS}>
      <p className="text-xs tracking-wide text-neutral-500 uppercase">Balance</p>
      <p className="text-foreground mt-1 text-3xl font-semibold tracking-tight tabular-nums">
        {formatUsd(wallet.balance)}
      </p>

      <dl className="mt-4 divide-y divide-[rgba(218,220,224,0.08)]">
        <Row label="Added" value={formatUsd(wallet.lifetimeToppedUp)} />
        <Row label="Spent" value={formatUsd(wallet.lifetimeSpent)} />
      </dl>

      {/*
       * Why the balance is not moving, said where the balance is — the only
       * place the difference is visible. Two different reasons with the same
       * symptom, so they get two different sentences: a wallet that never moves
       * looks broken unless something says which of these is true.
       */}
      {wallet.billingEnabled ? null : (
        <p className="mt-4 flex items-start gap-2 text-xs text-neutral-400">
          <Icon name="info" className="mt-px shrink-0 text-sm text-neutral-500" />
          <span>
            {wallet.usesOwnKey
              ? "This organization runs on its own AI Gateway key, so generations are billed by Vercel and nothing is taken from this balance."
              : "No AI Gateway key is configured, so generations return stand-in files and nothing is charged."}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Buying credit.
 *
 * The fee is broken out as its own line rather than folded into one number.
 * ¥100 of credit costing ¥105 is a thing somebody should be able to see the
 * shape of before they agree to it, and a single "¥105" with the arithmetic
 * left off is how a fee becomes a surprise on a card statement.
 */
function TopupCard() {
  const inputId = useId();
  const [selected, setSelected] = useState<number>(TOPUP_PRESETS[1]);
  const [custom, setCustom] = useState("");

  const start = useStartTopup();

  // A typed amount wins while it is valid; an unparseable one falls back to the
  // pressed preset so the button never goes dead without saying why.
  const parsed = custom.trim() === "" ? null : parseTopupAmount(custom);
  const credit = parsed ?? selected;
  const quote = quoteTopup(credit);
  const invalidCustom = custom.trim() !== "" && parsed === null;

  function submit() {
    if (invalidCustom) return;

    start.mutate(
      { credit },
      {
        // `window.location` rather than the router: with a real key this is a
        // `checkout.stripe.com` URL, and leaving the app is not a route change.
        onSuccess: (started) => (window.location.href = started.url)
      }
    );
  }

  return (
    <div className={CARD_CLASS}>
      <p className={SECTION_TITLE_CLASS}>Add credit</p>
      <p className="mt-1 text-xs text-neutral-400">
        A {TOPUP_FEE_BPS / 100}% handling fee is added at checkout.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {TOPUP_PRESETS.map((preset) => {
          const active = parsed === null && preset === selected;

          return (
            <button
              key={preset}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setSelected(preset);
                setCustom("");
              }}
              className={`${PRESET_CLASS} ${
                active
                  ? "text-foreground border-neutral-500 bg-[rgba(218,220,224,0.08)]"
                  : "border-[rgba(218,220,224,0.1)] text-neutral-300 hover:bg-[rgba(218,220,224,0.05)]"
              }`}
            >
              ${preset / MICRO_PER_DOLLAR}
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        <label htmlFor={inputId} className="text-xs text-neutral-400">
          Or another amount, in dollars
        </label>
        <input
          id={inputId}
          inputMode="decimal"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="e.g. 75"
          aria-invalid={invalidCustom}
          className={`${INPUT_CLASS} mt-1.5`}
        />
        {invalidCustom ? (
          <p role="alert" className="mt-1.5 text-xs text-red-400">
            Enter an amount between $5 and $2,000.
          </p>
        ) : null}
      </div>

      <dl className="mt-4 divide-y divide-[rgba(218,220,224,0.08)]">
        <Row label="Credit" value={formatUsd(quote.credit)} />
        <Row label={`Handling fee (${quote.feeRateBps / 100}%)`} value={formatUsd(quote.fee)} />
        <div className={`${ROW_CLASS} border-t border-[rgba(218,220,224,0.16)] pt-3`}>
          <dt className="text-foreground font-medium">You pay</dt>
          <dd className="text-foreground text-base font-medium tabular-nums">
            {formatUsd(quote.credit + quote.fee)}
          </dd>
        </div>
      </dl>

      {start.error ? (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {start.error.message}
        </p>
      ) : null}

      <Button
        onClick={submit}
        disabled={invalidCustom}
        pending={start.isPending}
        className="mt-4 w-full"
      >
        Continue to payment
      </Button>
    </div>
  );
}

/**
 * What has been called, and what it cost on each side.
 *
 * The upstream column is only ever populated when the Gateway reports a cost —
 * and it does not for every modality — so a blank there means "not reported"
 * rather than "free". Written as a dash for that reason: a zero in that column
 * would be a claim.
 */
function UsageCard({ rows }: { rows: readonly UsageSummaryRow[] }) {
  if (rows.length === 0) {
    return (
      <PageCard className="mt-4">
        <p className={SECTION_TITLE_CLASS}>Usage · last 30 days</p>
        <p className="mt-3 text-sm text-neutral-400">
          Nothing yet. Every model call made from a canvas is recorded here.
        </p>
      </PageCard>
    );
  }

  return (
    <PageCard className="mt-4">
      <p className={SECTION_TITLE_CLASS}>Usage · last 30 days</p>

      {/* Its own scroller, so a narrow sidebar-shrunk viewport scrolls the
          table rather than the page. */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th scope="col" className="py-2 pr-4 font-medium">
                Model
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Kind
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Key
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Calls
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Charged
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Upstream
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgba(218,220,224,0.08)]">
            {rows.map((row) => (
              <tr key={`${row.model}:${row.modality ?? "text"}:${row.keySource}`}>
                <td className="text-foreground py-2 pr-4">{row.model}</td>
                <td className="py-2 pr-4 text-neutral-400">{row.modality ?? "text"}</td>
                <td className="py-2 pr-4 text-neutral-400">
                  {row.keySource === "own" ? "yours" : "ours"}
                </td>
                <td className="py-2 pr-4 text-right text-neutral-300 tabular-nums">{row.calls}</td>
                <td className="text-foreground py-2 pr-4 text-right tabular-nums">
                  {formatUsd(row.charged)}
                </td>
                <td className="py-2 text-right text-neutral-400 tabular-nums">
                  {row.upstreamCost === null ? "—" : formatUsd(row.upstreamCost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageCard>
  );
}

function StatementCard({ lines }: { lines: readonly StatementLine[] }) {
  return (
    <PageCard className="mt-4">
      <p className={SECTION_TITLE_CLASS}>Statement</p>

      {lines.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-400">Nothing has moved in or out yet.</p>
      ) : (
        <ul role="list" className="mt-2 divide-y divide-[rgba(218,220,224,0.08)]">
          {lines.map((line) => (
            <li key={line.id} className="flex items-baseline justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm">
                  {line.description ?? KIND_LABEL[line.kind]}
                </p>
                <p className="text-xs text-neutral-500">
                  {/* Who, then when. On a shared wallet the first of those is
                      half the answer to "where did this go". */}
                  {line.actor ? `${line.actor} · ` : ""}
                  {new Date(line.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={`text-sm tabular-nums ${
                    line.amount > 0 ? "text-emerald-400" : "text-foreground"
                  }`}
                >
                  {line.amount > 0 ? "+" : "−"}
                  {formatUsd(Math.abs(line.amount))}
                </p>
                <p className="text-xs text-neutral-500 tabular-nums">
                  {formatUsd(line.balanceAfter)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PageCard>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={ROW_CLASS}>
      <dt className="text-neutral-400">{label}</dt>
      <dd className="text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

export function BillingPagePending() {
  return (
    <DashboardPage title="Credits">
      <p role="status" className="sr-only">
        Loading this organization's balance…
      </p>

      <div
        aria-hidden={true}
        className="mt-6 grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
      >
        <div className={`${CARD_CLASS} h-44 animate-pulse`} />
        <div className={`${CARD_CLASS} h-44 animate-pulse`} />
      </div>
    </DashboardPage>
  );
}

export function BillingPageError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();

  // The rejection is cached too; without this reset, retrying replays it.
  useEffect(() => {
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  return (
    <DashboardPage title="Credits">
      <PageErrorPanel
        title="We could not load this organization's balance."
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </DashboardPage>
  );
}
