import { findModel } from "#/lib/models";
import type { ModelOption, PriceUnit } from "#/lib/models";
import { microToCents, usd } from "#/lib/money";

/**
 * What something costs, worked out from the catalogue.
 *
 * Read from both sides and it has to give the same answer on each: the composer
 * quotes a press of the send button from it, and `runGeneration` debits the
 * wallet from it. A second implementation on the server is how someone is shown
 * one number and charged another, so there is one — and it is a pure function
 * of things both ends already hold.
 *
 * Everything below is **policy**. The prices themselves live on the model (see
 * `models.ts`); what is here is how they are combined and what margin is taken.
 */

/* -------------------------------------------------------------------------- */
/* Generations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a resolution tier multiplies a video's per-second price by.
 *
 * Video is the one modality whose resolution genuinely reaches the vendor, so
 * it is the one where charging by it is charging for something. The numbers are
 * a policy choice rather than a measurement — they say a 1080p second is worth
 * about twice a 720p one — and a tier missing from this table bills at 1×
 * rather than failing, because a tier the catalogue offers must always be
 * quotable.
 */
const VIDEO_RESOLUTION_MULTIPLIER: Record<string, number> = {
  "480p": 0.6,
  "720p": 1,
  "1080p": 1.8,
  "4k": 3.5
};

/** What a video costs when the model offers no duration menu and none was picked. */
const DEFAULT_VIDEO_SECONDS = 6;

/**
 * Charged once per billable generation, on top of the model's own price.
 *
 * It pays for the second Gateway call every generation makes: the small
 * language model that turns the prompt into a filename (`generation/title.ts`).
 * A flat fee rather than the call's measured token cost, because the quote has
 * to be exact *before* the prompt is sent and nobody can count the tokens of a
 * reply that has not happened yet — and a naming call is the same size every
 * time.
 *
 * It is deliberately not charged on a generation that falls through to the
 * sample provider. That call still happens and still costs us, but billing for
 * it would mean taking money for a stand-in file, which is the worse of the two
 * errors.
 */
export const NAMING_FEE = usd(0.001);

export interface GenerationQuote {
  /** Micro-dollars. Zero when this generation will not be billed at all. */
  total: number;
  /** The model's own share, before {@link NAMING_FEE}. */
  model: number;
  naming: number;
  /**
   * False when this generation does not reach the Gateway — an unpriced model,
   * or an app with no key configured — and so costs nothing and produces a
   * stand-in file. The quote is still a real answer: it is zero.
   */
  billable: boolean;
  /** What the model's share was counted in, for the statement line. */
  unit: PriceUnit | null;
  quantity: number | null;
}

export interface GenerationRequestShape {
  model: string;
  resolution?: string;
  aspectRatio?: string;
  /** Seconds, video only. */
  duration?: number;
  /** The prompt itself — speech is billed by how much text it is given. */
  prompt?: string;
}

const FREE_QUOTE: GenerationQuote = {
  total: 0,
  model: 0,
  naming: 0,
  billable: false,
  unit: null,
  quantity: null
};

/**
 * How many units of its own price a request buys.
 *
 * One picture, N seconds of video, or N thousand characters of speech — and
 * `1k_chars` is billed on a **minimum of one** rather than the true fraction,
 * because a two-word request still opens a connection to a vendor and the
 * alternative is a per-call price of a few micro-dollars that rounds to nothing.
 */
function quantityFor(price: NonNullable<ModelOption["price"]>, request: GenerationRequestShape) {
  switch (price.unit) {
    case "image":
      return 1;
    case "second":
      return request.duration && request.duration > 0 ? request.duration : DEFAULT_VIDEO_SECONDS;
    case "1k_chars":
      return Math.max(1, (request.prompt?.length ?? 0) / 1000);
  }
}

function multiplierFor(price: NonNullable<ModelOption["price"]>, request: GenerationRequestShape) {
  if (price.unit !== "second") return 1;

  return (request.resolution ? VIDEO_RESOLUTION_MULTIPLIER[request.resolution] : 1) ?? 1;
}

/**
 * What this generation will cost, or zero and `billable: false` if it will not
 * cost anything.
 *
 * `gatewayConfigured` is passed in rather than read, because it is a server
 * fact — whether `AI_GATEWAY_API_KEY` is set — and the browser has to be told
 * it to quote the same number the server will charge. It travels on the wallet
 * query, which every screen that shows a price already loads.
 */
export function quoteGeneration(
  request: GenerationRequestShape,
  gatewayConfigured: boolean
): GenerationQuote {
  if (!gatewayConfigured) return FREE_QUOTE;

  const model = findModel(request.model);
  const price = model?.price;

  // No price means no Gateway id means `getProvider` will answer with the
  // sample provider — the same rule, read from the same field. See
  // `assertPricedGateway` for why the two cannot drift apart.
  if (!model?.gateway || !price) return FREE_QUOTE;

  const quantity = quantityFor(price, request);
  const modelShare = Math.ceil(price.amount * quantity * multiplierFor(price, request));

  return {
    total: modelShare + NAMING_FEE,
    model: modelShare,
    naming: NAMING_FEE,
    billable: true,
    unit: price.unit,
    quantity
  };
}

/**
 * What a generation that could not be paid for says, on both sides of the wire.
 *
 * One string because it is thrown by the server and matched by the client: the
 * canvas refuses the press before a node is ever created, but the server check
 * is the authoritative one and a stale tab can still reach it. Two copies of
 * this sentence would drift into "insufficient credits" on one side and
 * "Insufficient credits." on the other, and the match would quietly stop.
 */
export const INSUFFICIENT_CREDITS_MESSAGE = "Not enough credits for this generation.";

/* -------------------------------------------------------------------------- */
/* Topping up                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The handling fee, in basis points. 500 bp is the 5% this app charges: put
 * $100 in the wallet and $105 is taken from the card.
 *
 * Note which way round it is quoted, because the two readings differ and only
 * one of them is what happens here: the fee is 5% **of the credit**, not 5% of
 * the charge — $5 on $105 is 4.76% of what is paid. The rate that is stored on
 * the order (`credit_topup.feeRateBps`) is this one, so an old order can always
 * be re-derived even after this constant moves.
 */
export const TOPUP_FEE_BPS = 500;

/** The credit amounts offered as buttons. Micro-dollars. */
export const TOPUP_PRESETS = [usd(10), usd(25), usd(50), usd(100), usd(200)] as const;

/** What a custom amount is allowed to be. Micro-dollars. */
export const MIN_TOPUP = usd(5);
export const MAX_TOPUP = usd(2_000);

export interface TopupQuote {
  /** Micro-dollars that will land in the wallet. */
  credit: number;
  /** Micro-dollars of handling fee — the difference, shown as its own line. */
  fee: number;
  /** Cents actually charged, which is the unit Stripe is handed. */
  chargeCents: number;
  feeRateBps: number;
}

/**
 * Prices one top-up.
 *
 * The fee is computed in micro-yuan and only then converted to the fen Stripe
 * quotes CNY in, once, at the end — `microToFen` rounds up, so a fractional fen
 * of fee is ours rather than a fen given away on every order that has one. The
 * credit is never touched by that rounding: what someone is told will land in
 * the wallet is exactly what lands.
 */
export function quoteTopup(credit: number, feeRateBps = TOPUP_FEE_BPS): TopupQuote {
  const fee = Math.round((credit * feeRateBps) / 10_000);

  return {
    credit,
    fee,
    chargeCents: microToCents(credit + fee),
    feeRateBps
  };
}

/** Whether an amount is one this app will sell. */
export function isSellableTopup(credit: number) {
  return Number.isSafeInteger(credit) && credit >= MIN_TOPUP && credit <= MAX_TOPUP;
}

/**
 * A typed amount, in dollars, turned into a credit this app will sell — or null.
 *
 * Rounded to whole cents before anything else: a top-up of $10.001 would be
 * charged as $10.51 and credited as $10.001, and the gap between those two
 * numbers is exactly the kind that gets noticed on a statement.
 */
export function parseTopupAmount(input: string) {
  const amount = Number(input);

  if (!Number.isFinite(amount) || amount <= 0) return null;

  const credit = usd(Math.round(amount * 100) / 100);

  return isSellableTopup(credit) ? credit : null;
}
