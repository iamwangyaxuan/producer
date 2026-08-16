import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import { topupOrderQueryOptions, useAbandonTopup, usePayTopup } from "#/lib/credits";
import { formatUsd } from "#/lib/money";

/**
 * The page Stripe would have hosted, for a one-time payment.
 *
 * The sibling of `checkout.$sessionId.tsx` and outside `_dashboard` for the
 * same reason: a checkout is not somewhere to browse from. With a real key
 * nothing routes here — `stripe.checkout.sessions.create` hands back a
 * `checkout.stripe.com` URL and the browser leaves — so this file, like that
 * one, is what a real integration deletes rather than reconfigures.
 */
export const Route = createFileRoute("/_auth/billing/topup/$sessionId")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(topupOrderQueryOptions(params.sessionId));
  },
  component: RouteComponent
});

const PAGE_CLASS = "flex min-h-screen items-center justify-center px-4 py-10";

const CARD_CLASS =
  "w-full max-w-md rounded-[18px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.03)] p-6";

const TITLE_CLASS = "text-foreground text-xl font-semibold tracking-tight";

const ROW_CLASS = "flex items-baseline justify-between gap-4 py-2 text-sm";

function RouteComponent() {
  const { sessionId } = Route.useParams();
  const { data: order } = useSuspenseQuery(topupOrderQueryOptions(sessionId));
  const router = useRouter();

  const pay = usePayTopup();
  const abandon = useAbandonTopup();

  if (!order) {
    return (
      <Outcome
        icon="help"
        title="No such top-up"
        description="This link has expired, or it belongs to a different account."
      />
    );
  }

  if (order.status === "paid") {
    return (
      <Outcome
        icon="check_circle"
        title={`${formatUsd(order.credit)} added`}
        description="It is in your balance and ready to spend."
      />
    );
  }

  if (order.status === "canceled") {
    return (
      <Outcome
        icon="cancel"
        title="Top-up cancelled"
        description="Nothing was charged, and no credit was added."
      />
    );
  }

  /**
   * Both of these end on the wallet page, and both are real routes in this app
   * — unlike the seat checkout, whose success URL is a better-auth endpoint. So
   * they navigate rather than assigning `window.location`, which keeps the
   * query cache (already invalidated by the mutation) instead of reloading the
   * document to rebuild it.
   */
  function confirm() {
    pay.mutate(
      { sessionId },
      { onSuccess: () => void router.navigate({ to: "/billing", search: { topup: "paid" } }) }
    );
  }

  function walkAway() {
    abandon.mutate({ sessionId }, { onSuccess: () => void router.navigate({ to: "/billing" }) });
  }

  const busy = pay.isPending || abandon.isPending;
  const error = pay.error ?? abandon.error;

  return (
    <div className={PAGE_CLASS}>
      <div className={CARD_CLASS}>
        <p className="text-xs tracking-wide text-neutral-500 uppercase">Add credit</p>
        <h1 className={`${TITLE_CLASS} mt-1`}>{formatUsd(order.credit)}</h1>

        {order.mock ? <MockNotice /> : null}

        <dl className="mt-5 divide-y divide-[rgba(218,220,224,0.08)]">
          <Row label="Credit" value={formatUsd(order.credit)} />
          <Row label={`Handling fee (${order.feeRateBps / 100}%)`} value={formatUsd(order.fee)} />
          <div className={`${ROW_CLASS} border-t border-[rgba(218,220,224,0.16)] pt-3`}>
            <dt className="text-foreground font-medium">Total</dt>
            <dd className="text-foreground text-base font-medium tabular-nums">
              {formatUsd(order.credit + order.fee)}
            </dd>
          </div>
        </dl>

        {error ? (
          // Verbatim, like the seat checkout: "the payment went through but the
          // credit was not added" is the one message somebody genuinely needs,
          // and `withTopupMessages` is what guarantees everything reaching here
          // was written to be read.
          <p role="alert" className="mt-4 text-sm text-red-400">
            {error.message}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={walkAway} disabled={pay.isPending}>
            Cancel
          </Button>
          {/* `pending` rather than `disabled`, so the button keeps focus while
              the charge is in flight; Base UI swallows the second click. */}
          <Button onClick={confirm} pending={busy}>
            Pay {formatUsd(order.credit + order.fee)}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={ROW_CLASS}>
      <dt className="text-neutral-400">{label}</dt>
      <dd className="text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * The one thing this page must not be coy about: it looks exactly like a
 * payment screen and takes no payment.
 */
function MockNotice() {
  return (
    <p className="mt-4 flex items-start gap-2 rounded-[12px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.05)] p-3 text-xs text-neutral-300">
      <Icon name="info" className="mt-px shrink-0 text-sm text-neutral-400" />
      <span>
        No Stripe account is configured, so this is a stand-in. Nothing is charged and no card is
        asked for — pressing pay adds the credit straight away.
      </span>
    </p>
  );
}

function Outcome({
  icon,
  title,
  description
}: {
  icon: string;
  title: string;
  description: ReactNode;
}) {
  return (
    <div className={PAGE_CLASS}>
      <div className={`${CARD_CLASS} flex flex-col items-center gap-2 text-center`}>
        <span className="flex size-12 items-center justify-center rounded-full bg-neutral-800 text-2xl text-neutral-400">
          <Icon name={icon} />
        </span>
        <h1 className={TITLE_CLASS}>{title}</h1>
        <p className="text-sm text-neutral-400">{description}</p>
        <Button
          nativeButton={false}
          render={<Link to="/billing" />}
          variant="secondary"
          className="mt-3"
        >
          Back to credits
        </Button>
      </div>
    </div>
  );
}
