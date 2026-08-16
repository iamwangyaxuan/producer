import { waitUntil } from "cloudflare:workers";

import { getDB, schema } from "#/db";
import type { AssetKind, GatewayKeySource, UsageEventPurpose, UsageEventStatus } from "#/db/schema";

/**
 * The meter: one row for every request that left this app for the AI Gateway.
 *
 * It is separate from the wallet on purpose. The wallet answers "what does this
 * organization owe"; this answers "what did we actually call, and what did it
 * cost us" — and the two do not line up one-to-one. A single generation is one charge
 * and *two* Gateway calls (the media, and the small language model that names
 * it); a generation on a model the Gateway does not serve is one charge of zero
 * and no calls at all. Either of those collapses badly if the two are one
 * table.
 *
 * Nothing in here is allowed to fail a generation. A missing meter row is a gap
 * in a report; a generation failed because its meter row would not insert is a
 * file somebody wanted, lost to bookkeeping.
 */

/** What one Gateway call is worth recording about itself. */
export interface GatewayCall {
  /** The `creator/model` string actually sent, e.g. `google/veo-3.1-generate-001`. */
  gatewayModel: string;
  latencyMs: number;
  /**
   * The SDK's `providerMetadata`, verbatim. The Gateway passes its own entry
   * through in here, which is where the upstream cost comes from.
   */
  providerMetadata?: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

const MICRO = 1_000_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * What the Gateway said this call cost us, in micro-dollars, or null.
 *
 * The same unit the wallet counts in, which is not a coincidence: this app
 * denominates in USD *because* that is what the Gateway bills in, so cost and
 * revenue land in one currency and the margin needs no conversion.
 *
 * Written defensively, and knowingly so. The cost rides in `providerMetadata`,
 * which the SDK forwards from the response body without a schema of its own
 * (`@ai-sdk/gateway` types it as `Record<string, JSONObject>`), so the shape is
 * the Gateway's to change and it is not the same for every modality. A number
 * or a decimal string are both accepted, several spellings are looked for, and
 * anything unrecognised answers null — because "we do not know what this cost"
 * has to be storable. A report with holes is honest; one with an invented zero
 * in every hole is not, which is why null is a column value rather than a
 * default of 0.
 */
export function upstreamCostMicro(providerMetadata: unknown): number | null {
  const gateway = asRecord(asRecord(providerMetadata)?.gateway);

  if (!gateway) return null;

  for (const key of ["cost", "totalCost", "costUsd"]) {
    const raw = gateway[key];
    const value = typeof raw === "string" ? Number(raw) : raw;

    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * MICRO);
  }

  return null;
}

/**
 * The slice of `providerMetadata` worth keeping on the row.
 *
 * The Gateway's own entry and nothing else: the rest can carry a base64 image
 * or a full safety report, and this column is read when somebody disputes a
 * charge, not when they want the response back.
 */
function billingMetadata(providerMetadata: unknown) {
  const gateway = asRecord(asRecord(providerMetadata)?.gateway);

  return gateway ? { gateway } : undefined;
}

export interface UsageEventInput {
  /** The wallet that paid. */
  organizationId: string;
  /** Who asked. Attribution only. */
  userId?: string | null;
  projectId?: string | null;
  assetId?: string | null;
  transactionId?: string | null;
  purpose: UsageEventPurpose;
  modality?: AssetKind | null;
  /** Catalogue id for a generation; the model constant for a naming call. */
  model: string;
  status: UsageEventStatus;
  error?: string | null;
  unit?: string | null;
  quantity?: number | null;
  /** Whose credentials it went out on. Defaults to ours. */
  keySource?: GatewayKeySource;
  /** Micro-dollars actually taken from the wallet for this call. */
  chargedAmount?: number;
  call?: GatewayCall | null;
}

/**
 * Records one call. Never throws — see the module comment.
 */
export async function recordUsageEvent(input: UsageEventInput) {
  try {
    await getDB()
      .insert(schema.usageEvent)
      .values({
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        projectId: input.projectId ?? null,
        assetId: input.assetId ?? null,
        transactionId: input.transactionId ?? null,
        purpose: input.purpose,
        modality: input.modality ?? null,
        model: input.model,
        gatewayModel: input.call?.gatewayModel ?? null,
        status: input.status,
        error: input.error ?? null,
        unit: input.unit ?? null,
        quantity: input.quantity ?? null,
        keySource: input.keySource ?? "system",
        chargedAmount: input.chargedAmount ?? 0,
        upstreamCost: upstreamCostMicro(input.call?.providerMetadata),
        inputTokens: input.call?.inputTokens ?? null,
        outputTokens: input.call?.outputTokens ?? null,
        latencyMs: input.call?.latencyMs ?? null,
        metadata: billingMetadata(input.call?.providerMetadata)
      });
  } catch (error) {
    // Worth a line: a meter that has stopped writing is invisible from the
    // product, and the first symptom would be a usage report that quietly
    // flattens out while the wallet keeps draining.
    console.error("failed to record a usage event", error);
  }
}

/**
 * Records a call whose result arrives after the response has already gone.
 *
 * There is exactly one of these — the naming call on a failed generation, which
 * has its own 20 second patience and must not be allowed to hold a request open
 * that has already failed. A bare `void promise` is not enough on Workers: an
 * isolate is free to stop executing once it has answered, so the insert would
 * land sometimes and vanish sometimes, which is the worst behaviour a meter can
 * have. `waitUntil` is what keeps it alive to finish.
 *
 * Guarded, because `waitUntil` needs a request to attach to and not every
 * caller of this module has one — a Durable Object alarm or a cron sweep does
 * not. There the work is merely started, which is what it was before.
 */
export function meterInBackground(work: Promise<unknown>) {
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}
