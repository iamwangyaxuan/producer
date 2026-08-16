import { useId, useState } from "react";
import type { FormEvent } from "react";

import Button from "#/components/ui/button";
import Dialog from "#/components/ui/dialog";
import Icon from "#/components/ui/icon";
import { ORGANIZATION_NAME_MAX_LENGTH } from "#/lib/billing";
import type { CreatableOrganizationType } from "#/lib/organization";
import { clampSeats, formatAmount, SEAT_PLANS, seatTotal } from "#/lib/plans";
import type { SeatPlan } from "#/lib/plans";

const FIELD_CLASS =
  "text-foreground mt-1.5 w-full rounded-[12px] border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.05)] px-3 py-2 text-sm outline-hidden transition placeholder:text-neutral-500 focus-visible:border-neutral-500 disabled:opacity-50";

const LABEL_CLASS = "block text-sm text-neutral-400";

/**
 * A native radio inside the card it selects.
 *
 * The input is visually hidden rather than replaced, which is what keeps arrow
 * keys moving between the plans, the group announcing itself as a group, and
 * the form submitting a value — all of which a `<button aria-checked>` would
 * have had to reimplement. `has-checked` / `group-has-checked` reads the real
 * checked state off the real control, so nothing has to be mirrored into
 * React state to make the card look selected.
 */
const PLAN_CARD_CLASS = [
  "group flex cursor-default items-start gap-3 rounded-[12px] p-3 transition",
  "border border-[rgba(218,220,224,0.1)] bg-[rgba(218,220,224,0.03)]",
  "hover:border-[rgba(218,220,224,0.2)]",
  "has-checked:border-neutral-500 has-checked:bg-[rgba(218,220,224,0.08)]",
  // Colour first and unconditionally: `transition` above covers `outline-color`,
  // so a ring that gets its colour from the variant fades in from the text
  // colour instead of arriving blue.
  "outline-blue-500 has-focus-visible:outline-2 has-focus-visible:outline-offset-2"
].join(" ");

export interface CreateOrganizationValues {
  name: string;
  type: CreatableOrganizationType;
  seats: number;
}

export interface CreateOrganizationDialogProps {
  open: boolean;
  onClose: () => void;
  /** Handed a trimmed name and a seat count already inside the plan's range. */
  onSubmit: (values: CreateOrganizationValues) => void;
  error: Error | null;
  pending: boolean;
}

/**
 * What someone fills in before they pay: a name, a plan, and how many people
 * it is for.
 *
 * It holds its own draft rather than lifting it to the caller, unlike the
 * rename dialog next door — that one is seeded from the project it edits, while
 * this starts from nothing every time. Base UI unmounts a closed dialog's
 * contents, so closing it is what resets the form; there is no effect keeping
 * the two in step.
 *
 * The button says "checkout" because that is what it does. Nothing exists yet
 * when it is pressed — the organization is created by the payment, not by this
 * form — and a button labelled "Create" would be promising the wrong thing.
 */
export function CreateOrganizationDialog({
  open,
  onClose,
  onSubmit,
  error,
  pending
}: CreateOrganizationDialogProps) {
  const nameId = useId();
  const seatsId = useId();
  const planName = useId();

  const [name, setName] = useState("");
  const [plan, setPlan] = useState<SeatPlan>(SEAT_PLANS[0]);
  // Annotated, because the catalogue is `as const` and would otherwise pin this
  // to the literal type of the first plan's default.
  const [seats, setSeats] = useState<number>(SEAT_PLANS[0].defaultSeats);

  // What will actually be charged for. The input is left alone while it is
  // being typed into — clamping on every keystroke makes a field impossible to
  // clear — so the number on screen and the number in the total can disagree
  // mid-edit, and the total is the one that tells the truth.
  const chargeable = clampSeats(plan, seats);
  const outOfRange = seats !== chargeable;

  function choosePlan(next: SeatPlan) {
    setPlan(next);
    // Enterprise starts at ten; carrying a team-sized number across would put
    // the form in an invalid state nobody asked for.
    setSeats((current) => clampSeats(next, current));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = name.trim();

    // The submit button is disabled without a name; this is the keyboard path
    // to the same submit, which a disabled button does not always intercept.
    if (!trimmed || pending) return;

    onSubmit({ name: trimmed, type: plan.name, seats: chargeable });
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Content className="max-w-md">
        <form onSubmit={submit}>
          <Dialog.Title>New organization</Dialog.Title>
          <Dialog.Description>
            Seats are bought up front — the organization is created once the payment goes through.
          </Dialog.Description>

          <label htmlFor={nameId} className={`${LABEL_CLASS} mt-5`}>
            Name
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={ORGANIZATION_NAME_MAX_LENGTH}
            placeholder="Acme Studio"
            disabled={pending}
            className={FIELD_CLASS}
          />

          {/* A fieldset rather than a bare list: the legend is what names the
              radio group, and without one every option announces on its own
              with nothing saying what is being chosen. */}
          <fieldset disabled={pending} className="mt-5">
            <legend className={LABEL_CLASS}>Plan</legend>
            <div className="mt-1.5 flex flex-col gap-2">
              {SEAT_PLANS.map((entry) => (
                <label key={entry.name} className={PLAN_CARD_CLASS}>
                  <input
                    type="radio"
                    name={planName}
                    value={entry.name}
                    checked={plan.name === entry.name}
                    onChange={() => choosePlan(entry)}
                    className="sr-only"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">{entry.label}</p>
                    <p className="mt-0.5 text-xs text-neutral-400">{entry.description}</p>
                    <p className="mt-1.5 text-xs text-neutral-300">
                      {formatAmount(entry.unitAmount, entry.currency)} per seat / {entry.interval}
                    </p>
                  </div>
                  {/* Kept in the layout for the unselected card as a spacer
                      would be, so nothing shifts when the choice changes. */}
                  <Icon
                    name="check"
                    className="text-base opacity-0 transition-opacity group-has-checked:opacity-100"
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <label htmlFor={seatsId} className={`${LABEL_CLASS} mt-5`}>
            Seats
          </label>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              id={seatsId}
              type="number"
              inputMode="numeric"
              min={plan.minSeats}
              max={plan.maxSeats}
              value={seats}
              onChange={(event) => setSeats(event.target.valueAsNumber)}
              onBlur={() => setSeats(chargeable)}
              disabled={pending}
              aria-describedby={`${seatsId}-range`}
              className={`${FIELD_CLASS} mt-0 w-24`}
            />
            <p id={`${seatsId}-range`} className="text-xs text-neutral-500">
              {plan.minSeats}–{plan.maxSeats} seats
            </p>
          </div>

          {outOfRange ? (
            <p className="mt-2 text-xs text-neutral-400">
              {plan.label} is sold in {plan.minSeats}–{plan.maxSeats} seats, so {chargeable} is what
              will be charged for.
            </p>
          ) : null}

          <div className="mt-5 flex items-baseline justify-between rounded-[12px] bg-[rgba(218,220,224,0.05)] px-3 py-2.5">
            <span className="text-xs text-neutral-400">
              {chargeable} × {formatAmount(plan.unitAmount, plan.currency)}
            </span>
            <span className="text-foreground text-sm font-medium">
              {formatAmount(seatTotal(plan, chargeable), plan.currency)} / {plan.interval}
            </span>
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {import.meta.env.DEV ? error.message : "Something went wrong. Please try again."}
            </p>
          ) : null}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close disabled={pending} render={<Button variant="ghost" />}>
              Cancel
            </Dialog.Close>
            {/* `pending` rather than `disabled` while the checkout is being
                created: the button keeps focus and Base UI swallows the click
                anyway, so nothing submits twice. */}
            <Button type="submit" pending={pending} disabled={name.trim() === ""}>
              Continue to checkout
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
