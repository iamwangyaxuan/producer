import { experimental_generateVideo as generateVideo, generateImage, generateSpeech } from "ai";

import type { ModelOption } from "#/lib/models";
import { getGateway } from "#/server/generation/gateway";
import type {
  GenerationProvider,
  GenerationReference,
  GenerationRequest,
  GenerationResult
} from "#/server/generation/provider";

/**
 * The real backend: a catalogue choice turned into an AI Gateway call.
 *
 * One function per modality because the AI SDK has one per modality — images,
 * video and speech are different call shapes with different results, not one
 * call with a flag. What they share is what this module is for: the same
 * gateway client, the same way of getting bytes out, and the same contract
 * back to `runGeneration`, which knows nothing about any of it.
 *
 * Music has no branch because the Gateway has no music models — no Lyria, no
 * Suno, nothing under a `music` type at all. `getProvider` never routes one
 * here; see the catalogue's `gateway` field for the rule.
 */

/**
 * Every one of these hands back the whole file in memory, and there is no
 * streaming alternative: `generateImage`, `generateVideo` and `generateSpeech`
 * all resolve to a `GeneratedFile` holding a `Uint8Array`. For a still or a
 * spoken line that is nothing. For video it is the ceiling on what this can
 * generate — a Worker isolate has 128MB, and a long clip at 1080p will reach
 * it. Worth knowing before someone raises the duration menu's top end.
 */
function fileResult(file: { uint8Array: Uint8Array; mediaType: string }): GenerationResult {
  return { body: toArrayBuffer(file.uint8Array), contentType: file.mediaType };
}

/**
 * A `Uint8Array` is a *view*, and it is not always the whole of its buffer —
 * handing `.buffer` straight to R2 can therefore store more bytes than the
 * file has. Slicing is the copy that makes the two agree.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * The aspect ratio in the shape the SDK's types insist on, or undefined.
 *
 * The catalogue stores ratios as plain strings and the SDK types them as
 * `` `${number}:${number}` ``, so something has to check rather than assert —
 * and checking is worth more than a cast: these strings reach the vendor's own
 * API, where a malformed one is a failed generation rather than a type error.
 */
function ratio(value: string | undefined) {
  if (!value) return undefined;

  const [width, height] = value.split(":");

  if (!width || !height || !Number.isFinite(Number(width)) || !Number.isFinite(Number(height))) {
    return undefined;
  }

  return `${Number(width)}:${Number(height)}` as const;
}

/** Standard heights behind the video tiers the catalogue offers. */
const VIDEO_HEIGHTS: Record<string, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "4k": 2160
};

/**
 * A video tier and a shape turned into the pixel pair the SDK asks for.
 *
 * Video tiers name a height and nothing else — 720p is 720 rows however wide
 * the frame is — so the ratio supplies the rest. Widths are rounded to an even
 * number because encoders in this space reject odd dimensions.
 *
 * The image tiers (`1K`/`2K`/`4K`) are deliberately *not* given the same
 * treatment. `generateImage` takes either a `size` or an `aspectRatio` and the
 * models disagree about which — xAI's take no `size` at all — so a computed
 * pixel pair would fail the request on some of the catalogue and work on the
 * rest. Ratio alone is understood everywhere, so that is what is sent, and the
 * image resolution menu currently only reaches the vendor's own default. It
 * wants per-model handling, not a guess.
 */
function videoResolution(tier: string | undefined, aspectRatio: string | undefined) {
  const height = tier ? VIDEO_HEIGHTS[tier] : undefined;

  if (height === undefined) return undefined;

  const parsed = ratio(aspectRatio);
  const [width, tall] = parsed ? parsed.split(":").map(Number) : [16, 9];
  const pixels = Math.round((height * (width ?? 16)) / (tall ?? 9) / 2) * 2;

  return `${pixels}x${height}` as const;
}

/** The attached files a vendor can actually take as picture input. */
function imageReferences(references: readonly GenerationReference[]) {
  return references.filter((reference) => reference.kind === "image");
}

/**
 * References travel as their presigned URLs rather than as bytes.
 *
 * The SDK accepts either, and a URL is the cheaper of the two by a whole
 * round trip: the alternative is this Worker fetching the object out of R2 and
 * posting it onward, when the vendor can fetch it directly. It is also the
 * reason those URLs are minted short-lived — see `GenerationReference`.
 */
export function gatewayProvider(model: ModelOption): GenerationProvider {
  return {
    async run(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult> {
      const gateway = getGateway();

      // Unreachable through `getProvider`, which checks both before routing
      // here. Left as a throw so a future caller that skips those checks fails
      // loudly instead of sending a request with no credentials.
      if (!gateway || !model.gateway) throw new Error("The AI Gateway is not configured.");

      switch (request.modality) {
        case "image": {
          const images = imageReferences(request.references);

          const { image } = await generateImage({
            model: gateway.imageModel(model.gateway),
            // The object form is what turns a plain generation into an edit:
            // with pictures attached the prompt is written *about* them.
            prompt:
              images.length > 0
                ? { images: images.map((reference) => reference.url), text: request.prompt }
                : request.prompt,
            aspectRatio: ratio(request.aspectRatio),
            abortSignal: signal
          });

          return fileResult(image);
        }
        case "video": {
          const [first] = imageReferences(request.references);

          const { video } = await generateVideo({
            model: gateway.videoModel(model.gateway),
            // One picture, not the list: this is image-to-video, where the
            // attachment is the opening frame rather than a mood board.
            prompt: first ? { image: first.url, text: request.prompt } : request.prompt,
            aspectRatio: ratio(request.aspectRatio),
            resolution: videoResolution(request.resolution, request.aspectRatio),
            duration: request.duration,
            abortSignal: signal
          });

          return fileResult(video);
        }
        case "voice": {
          const { audio } = await generateSpeech({
            model: gateway.speechModel(model.gateway),
            text: request.prompt,
            voice: model.voice,
            abortSignal: signal
          });

          return fileResult(audio);
        }
        case "music":
          // See the module comment: nothing routes here.
          throw new Error("The AI Gateway has no music models.");
      }
    }
  };
}
