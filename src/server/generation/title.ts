import { generateObject } from "ai";
import type { createGateway } from "ai";
import { z } from "zod";

import type { GatewayCall } from "#/server/generation/metering";

/**
 * Naming a generated file.
 *
 * This needs a model, which is the whole reason it exists: turning "生成一张在
 * 草地上奔跑的小狗的照片" into "奔跑的小狗" is a summarization job, and no
 * amount of truncating or keyword-plucking does it — the useful part of a
 * prompt is rarely its first words, and never a fixed slice of them.
 *
 * The image and video APIs are no help here either: they answer with bytes and
 * a `Content-Type`, never a name. Where a provider's response does carry a
 * path, it is a storage key — an opaque id, not something to show a person.
 * So the name is ours to write.
 */

/**
 * A schema rather than free text, for two reasons: the response is guaranteed
 * parseable, and a model that would otherwise open with "Here's a title:" has
 * nowhere to put it.
 */
const titleSchema = z.object({
  title: z
    .string()
    .describe(
      "A short noun phrase naming the result. No quotes, no punctuation, no file extension."
    )
});

/** Long enough for a phrase in any language, short enough to stay a filename. */
const MAX_TITLE_LENGTH = 60;

/**
 * Small on purpose. This runs on every generation, in the path of it, and
 * naming a file is not work that repays a larger model — the reason the old
 * call reached for one was that it also had to be told to think as little as
 * possible. Haiku is the cheap end of the same family, and through the Gateway
 * it is one string away from being any other model on the list.
 */
export const TITLE_MODEL = "anthropic/claude-haiku-4.5";

/**
 * Well under any provider's own patience: naming runs alongside the
 * generation, so an answer that arrives after the bytes have landed is worth
 * less than not blocking on it.
 */
const TITLE_TIMEOUT_MS = 20_000;

const SYSTEM = [
  "You name files. Given the prompt someone wrote to generate a piece of media,",
  "reply with a short title for the resulting file.",
  "",
  "Rules:",
  "- 2 to 6 words. A noun phrase, not a sentence.",
  "- Name the subject, not the request: for 'generate a photo of a dog running",
  "  on the grass', the title is 'running dog' — never 'generate a photo'.",
  "- Drop words describing the medium or the act of making it (photo, image,",
  "  video, render, generate, create, draw), unless dropping them leaves nothing.",
  "- Write in the same language the prompt is written in.",
  "- No quotes, no trailing punctuation, no file extension."
].join("\n");

export interface AssetTitleResult {
  /** Null when the model could not be reached, or answered with nothing. */
  title: string | null;
  /**
   * The Gateway call this made, for the meter — present even when the naming
   * failed, because a request that was sent and then errored is still a request
   * the Gateway may have billed us for. Null only when no request was made at
   * all: no key, or an empty prompt.
   */
  call: GatewayCall | null;
  error: string | null;
}

const NOT_CALLED: AssetTitleResult = { title: null, call: null, error: null };

/**
 * A short name for what this prompt produces, plus what asking for it cost.
 *
 * Never a thrown error, and never a reason to fail the generation: a file whose
 * name did not come back is still the file the person asked for, and
 * `assetTitle` has a fallback chain for exactly this. The caller runs it
 * alongside the provider so its latency hides behind work that is already
 * slower.
 *
 * It answers with the call it made as well as the name, because this is the
 * *second* Gateway request every generation sends and a meter that only counted
 * the first would under-report every generation in the product by one call. The
 * flat `NAMING_FEE` in `pricing.ts` is what pays for it.
 */
export async function generateAssetTitle(
  prompt: string,
  gateway: ReturnType<typeof createGateway> | null
): Promise<AssetTitleResult> {
  const trimmed = prompt.trim();

  if (trimmed === "") return NOT_CALLED;

  // No gateway, no request. Without this the SDK still opens a connection it
  // cannot authenticate, and the failure arrives as an async socket error from
  // deep inside `fetch` — after this function has already returned, so the
  // `catch` below never sees it and the dev server shows an error overlay for
  // a call that was working as designed.
  //
  // It arrives as an argument rather than being looked up, so the name is
  // written on the same credentials the media was generated with: an
  // organization on its own key gets billed by Vercel for both halves of its
  // generation, or for neither.
  if (!gateway) return NOT_CALLED;

  const startedAt = performance.now();

  try {
    const { object, usage, providerMetadata } = await generateObject({
      model: gateway.languageModel(TITLE_MODEL),
      // A schema rather than a parsed reply: the SDK holds the model to the
      // shape and hands back a typed object, so there is no format to agree on
      // between the two ends and nothing to parse here.
      schema: titleSchema,
      system: SYSTEM,
      prompt: trimmed,
      // One attempt. A retry here buys nothing — the fallback name is already
      // acceptable — and costs a second connection held open inside a request
      // that is only waiting on this to be polite.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS)
    });

    const title = object.title.trim();

    return {
      title: title ? title.slice(0, MAX_TITLE_LENGTH) : null,
      call: {
        gatewayModel: TITLE_MODEL,
        latencyMs: Math.round(performance.now() - startedAt),
        providerMetadata,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
      },
      error: null
    };
  } catch (error) {
    // Worth a line — a naming call failing every time means a missing or
    // rejected key, which is silent otherwise because the fallback covers it.
    console.error("failed to generate an asset title", error);

    return {
      title: null,
      // Recorded as a call that happened, because it did: the request left this
      // Worker. Whether the Gateway billed for it is its business; leaving it
      // out of the meter would make a run of failures look like a run of
      // generations that never needed naming.
      call: { gatewayModel: TITLE_MODEL, latencyMs: Math.round(performance.now() - startedAt) },
      error: error instanceof Error ? error.message : "Naming failed."
    };
  }
}
