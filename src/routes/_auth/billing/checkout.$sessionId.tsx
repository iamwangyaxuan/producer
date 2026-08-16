import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import Button from "#/components/ui/button";
import Icon from "#/components/ui/icon";
import { checkoutOrderQueryOptions, useAbandonCheckout, usePayCheckout } from "#/lib/billing";
import { formatAmount } from "#/lib/plans";

/**
 * The page Stripe would have hosted.
 *
 * It is under `_auth` but outside `_dashboard` on purpose: a checkout is not a
 * place to browse from. There is no sidebar and no way onwards except paying or
 * walking away, which is how the hosted page behaves and is the reason nobody
 * abandons one by accident.
 *
 * With a real key configured nothing routes here — the plugin hands back a
 * `checkout.stripe.com` URL and the browser leaves — so this file is the local
 * stand-in's screen and the only part of the flow that a real integration
 * deletes rather than reconfigures.
 */
export const Route = createFileRoute("/_auth/billing/checkout/$sessionId")({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(checkoutOrderQueryOptions(params.sessionId));
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
  const { data: order } = useSuspenseQuery(checkoutOrderQueryOptions(sessionId));

  const pay = usePayCheckout();
  const abandon = useAbandonCheckout();

  if (!order) {
    return (
      <Outcome
        icon="help"
        title="No such checkout"
        description="This link has expired, or it belongs to a different account."
      />
    );
  }

  if (order.status === "complete") {
    return (
      <Outcome
        icon="check_circle"
        title={`${order.organizationName} is ready`}
        description={`${order.seats} seats on the ${order.plan.label} plan. It is now the organization you are working in.`}
      />
    );
  }

  if (order.status === "expired") {
    return (
      <Outcome
        icon="cancel"
        title="Checkout cancelled"
        description="Nothing was charged, and no organization was created."
      />
    );
  }

  /**
   * Both of these leave through `window.location` rather than the router,
   * because both URLs came from the checkout session rather than from this
   * app's route tree — with a real key they point at Stripe's redirect targets,
   * and `successUrl` is a better-auth endpoint that reconciles the subscription
   * and then redirects again. Neither is a route the client-side router knows.
   */
  function confirm() {
    pay.mutate({ sessionId }, { onSuccess: (paid) => (window.location.href = paid.successUrl) });
  }

  function walkAway() {
    abandon.mutate(
      { sessionId },
      { onSuccess: (abandoned) => (window.location.href = abandoned.cancelUrl) }
    );
  }

  const busy = pay.isPending || abandon.isPending;
  // Either request failing leaves the person on this page needing to know why,
  // and only one of them can be in flight at a time.
  const error = pay.error ?? abandon.error;

  return (
    <div className={PAGE_CLASS}>
      <div className={CARD_CLASS}>
        <p className="text-xs tracking-wide text-neutral-500 uppercase">Checkout</p>
        <h1 className={`${TITLE_CLASS} mt-1`}>{order.organizationName}</h1>

        {order.mock ? <MockNotice /> : null}

        <dl className="mt-5 divide-y divide-[rgba(218,220,224,0.08)]">
          <Row label="Plan" value={order.plan.label} />
          <Row label="Seats" value={String(order.seats)} />
          <Row
            label="Per seat"
            value={`${formatAmount(order.plan.unitAmount, order.currency)} / ${order.plan.interval}`}
          />
          <div className={`${ROW_CLASS} border-t border-[rgba(218,220,224,0.16)] pt-3`}>
            <dt className="text-foreground font-medium">Total</dt>
            <dd className="text-foreground text-base font-medium">
              {formatAmount(order.total, order.currency)} / {order.plan.interval}
            </dd>
          </div>
        </dl>

        {error ? (
          // Shown verbatim, unlike the dialogs elsewhere: every message that
          // reaches here was written for a person to read, because a checkout
          // that has taken money cannot afford "something went wrong". See
          // `withCheckoutMessages` for where that is guaranteed.
          <p role="alert" className="mt-4 text-sm text-red-400">
            {error.message}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={walkAway} disabled={pay.isPending}>
            Cancel
          </Button>
          {/* `pending` rather than `disabled`: the button keeps focus while the
              charge is in flight, and Base UI swallows the click anyway, so a
              second press cannot buy a second organization. */}
          <Button onClick={confirm} pending={busy}>
            Pay {formatAmount(order.total, order.currency)}
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
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The one thing this page must not be coy about. It looks exactly like a
 * payment screen and takes no payment, so it says so where the card field would
 * be — nobody should be able to reach the button without having read this.
 */
function MockNotice() {
  return (
    <p className="mt-4 flex items-start gap-2 rounded-[12px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.05)] p-3 text-xs text-neutral-300">
      <Icon name="info" className="mt-px shrink-0 text-sm text-neutral-400" />
      <span>
        No Stripe account is configured, so this is a stand-in. Nothing is charged and no card is
        asked for — pressing pay creates the organization straight away.
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
        {/* Back inside the app, and a real navigation this time — unlike the
            checkout URLs above, this is a route. */}
        <Button
          nativeButton={false}
          render={<Link to="/projects" />}
          variant="secondary"
          className="mt-3"
        >
          Go to projects
        </Button>
      </div>
    </div>
  );
}
