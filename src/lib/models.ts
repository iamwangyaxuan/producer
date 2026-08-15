import type { AssetKind } from "#/db/schema";

/**
 * The model catalogue: what the composer offers, and what the server has to
 * turn each choice into a request.
 *
 * It lives out here rather than in the composer because both halves of the app
 * read it. The composer builds its menus from it; `getProvider` on the server
 * looks an entry up by id to find out whether the choice is one the AI Gateway
 * can actually serve. Two copies of this list would drift the moment a model
 * was added to one of them.
 */

/**
 * What the canvas calls an asset kind. The same four the `asset` table stores,
 * by definition rather than by a second list that has to be kept in step —
 * a modality the composer offers and the column refuses is not a thing.
 */
export type Modality = AssetKind;

export interface ModelOption {
  /** The exact string the provider's API takes. */
  id: string;
  name: string;
  /** Doubles as the menu's group heading, so models arrive sorted by who makes them. */
  provider: string;
  modality: Modality;
  /**
   * Size tiers, one vocabulary across every provider — `480p`/`720p`/`1080p`/`4k`
   * for video, `1K`/`2K`/`4K` for stills — with shape kept out of it and left to
   * `aspectRatios`.
   *
   * Two of these providers do not take a tier: Sora and GPT Image are given a
   * width×height pair instead. Composing one is the call site's job, and the
   * lists here are cut so that every tier×ratio the menus can produce is a pair
   * those APIs accept. Sora's own set is not a full product — it publishes
   * 1024×1792 and 1792×1024 alongside the 16:9 and 9:16 sizes — so that odd pair
   * is left out rather than modelled as a ratio that only exists at one tier.
   */
  resolutions?: readonly string[];
  /** Shape, independent of the tier above. */
  aspectRatios?: readonly string[];
  /** Seconds, video only. */
  durations?: readonly number[];
  /**
   * File kinds this model takes *as input*, when that differs from what its
   * output modality implies — see {@link DEFAULT_ACCEPTS} for the rule this
   * overrides.
   */
  accepts?: readonly AssetKind[];
  /**
   * What the Vercel AI Gateway calls this model, in its own `creator/model`
   * namespace — and the flag for whether a choice is real.
   *
   * Present means the Gateway serves it and the generation runs for real;
   * absent means the request falls back to `sampleProvider`, which returns a
   * stand-in file. That is the entire routing rule (see `getProvider`), and
   * writing it as a field on the model rather than as a table somewhere on the
   * server is what keeps "this model exists" and "this model works" from being
   * two lists to reconcile.
   *
   * **Every value here was read off the Gateway's own model list**
   * (`https://ai-gateway.vercel.sh/v1/models`, no auth required) rather than
   * guessed from the vendor's docs — which is also how the two ids this
   * catalogue had flagged as unverified were finally settled, and both were
   * wrong: ByteDance publishes `bytedance/seedream-5.0-pro`, not
   * `doubao-seedream-5-0-pro`.
   *
   * The absences are not oversights. Sora, ElevenLabs and Lyria are not on the
   * Gateway at all, and Google's Nano Banana models are there but as *language*
   * models that return images in `result.files` — a different call shape from
   * `generateImage`, and a second image path this does not yet have.
   */
  gateway?: string;
  /**
   * The voice to ask for, where the model has no usable default of its own.
   * Speech models only.
   */
  voice?: string;
}

/**
 * What a model will take as an attachment, inferred from what it produces.
 *
 * Coarser than the resolution and duration lists above, and deliberately so:
 * those are enumerated from each provider's documentation because sending a
 * value outside them fails the request, while this only decides whether the
 * composer *offers* a file. Image and video models are image-conditioned
 * across the board — editing a picture, or animating one — and the two sound
 * families are text-to-audio, which is why their default is nothing at all.
 *
 * A model that departs from its family says so with `accepts`, and anything
 * finer than this belongs in that field rather than here.
 */
const DEFAULT_ACCEPTS: Record<Modality, readonly AssetKind[]> = {
  image: ["image"],
  video: ["image"],
  voice: [],
  music: []
};

/** The file kinds this model can be handed, however that was decided. */
export function modelAccepts(model: ModelOption): readonly AssetKind[] {
  return model.accepts ?? DEFAULT_ACCEPTS[model.modality];
}

/**
 * Every entry here is a model with a public API whose size and length options
 * are enumerated in that provider's own documentation — the lists are what the
 * API accepts, not a plausible-looking guess, so a picked combination is one a
 * request can actually be built from.
 *
 * That bar is what decides who is in it. Several models that top the 2026
 * rankings are deliberately absent: Midjourney V8.1 and Suno v5 have no
 * self-serve public API to call, and for Seedance 2.0, Kling 3.0, Hailuo 3.0,
 * Runway Gen-4.5, Luma Ray3, FLUX.2, Ideogram 4 and Recraft V4.1 the resolution
 * and duration values published by resellers and roundups disagree with each
 * other. Adding one is a single entry once its own docs are read.
 *
 * First entry of each modality is that modality's default.
 */
export const MODELS: readonly ModelOption[] = [
  // Image — a size tier and a shape, no length.
  {
    id: "gpt-image-2",
    gateway: "openai/gpt-image-2",
    name: "GPT Image 2",
    provider: "OpenAI",
    modality: "image",
    // Takes a pixel pair, any width×height divisible by 16 between 1:3 and 3:1
    // and no larger than 3840×2160 — so the tiers below are the call site's to
    // compose, and every ratio here stays inside that envelope at 4K.
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"]
  },
  {
    id: "gemini-3-pro-image",
    name: "Nano Banana Pro",
    provider: "Google",
    modality: "image",
    // Gemini rejects a lowercase `k`, so the casing here is the wire value.
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Nano Banana 2",
    provider: "Google",
    modality: "image",
    // Also takes `512px`, the one value in either family that is neither a `p`
    // nor a `K` tier; left out rather than shown in a vocabulary of its own.
    resolutions: ["1K", "2K", "4K"],
    aspectRatios: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
  },
  {
    id: "imagen-4.0-generate-001",
    gateway: "google/imagen-4.0-generate-001",
    name: "Imagen 4",
    provider: "Google",
    modality: "image",
    // Its published sizes run 1024² through 2816×1536 — two tiers, five shapes.
    resolutions: ["1K", "2K"],
    aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9"]
  },
  {
    id: "grok-imagine-image-2.0",
    gateway: "xai/grok-imagine-image-2.0",
    name: "Grok Imagine 2.0",
    provider: "xAI",
    modality: "image",
    // Grok already separates the two, which is the shape everything else here
    // is being brought into line with. It documents 14 ratios; these are the
    // ones that are not a niche social crop.
    resolutions: ["1K", "2K"],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2"]
  },
  {
    // ⚠ The one id here not taken from its provider's own docs: BytePlus renders
    // its documentation client-side, so the model list could not be read, and
    // ByteDance's real endpoint ids carry a release-date suffix
    // (`doubao-seedream-4-0-250828`). Confirm against ModelArk before this is
    // put in a request — the option lists below are corroborated, the id is not.
    id: "doubao-seedream-5-0-pro",
    gateway: "bytedance/seedream-5.0-pro",
    name: "Seedream 5.0 Pro",
    provider: "ByteDance",
    modality: "image",
    // Two tiers and eight shapes, agreed on by two independent API hosts.
    resolutions: ["1K", "2K"],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"]
  },

  // Voice — speech and TTS only, now that the two music generators have a
  // heading of their own. Neither resolution nor duration applies, so a picked
  // voice model leaves the composer with just the model menu.
  // The one voice model here that is not text-to-speech: it is a speech-to-
  // speech conversation model, so it takes audio in as well as out.
  // The three the Gateway actually serves, and the only voice models here that
  // produce sound rather than a stand-in. First, because the first entry of a
  // modality is its default and a default that works beats a famous one that
  // does not.
  {
    id: "tts-1-hd",
    name: "TTS-1 HD",
    provider: "OpenAI",
    modality: "voice",
    gateway: "openai/tts-1-hd",
    // OpenAI's speech endpoint requires a voice; the catalogue is where a
    // model's own requirements belong, so the provider need not know whose
    // model it is holding.
    voice: "alloy"
  },
  { id: "grok-tts", name: "Grok TTS", provider: "xAI", modality: "voice", gateway: "xai/grok-tts" },
  {
    id: "s2.1-pro",
    name: "Fish Audio S2.1 Pro",
    provider: "Fish Audio",
    modality: "voice",
    gateway: "fish-audio/s2.1-pro"
  },
  {
    id: "gpt-realtime-2.1",
    name: "GPT Realtime 2.1",
    provider: "OpenAI",
    modality: "voice",
    accepts: ["voice"]
  },
  { id: "gpt-4o-mini-tts", name: "GPT-4o mini TTS", provider: "OpenAI", modality: "voice" },
  {
    id: "gemini-3.1-flash-tts-preview",
    name: "Gemini 3.1 Flash TTS",
    provider: "Google",
    modality: "voice"
  },
  { id: "eleven_v3", name: "Eleven v3", provider: "ElevenLabs", modality: "voice" },
  { id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", provider: "ElevenLabs", modality: "voice" },
  { id: "grok-voice-think-fast-2.0", name: "Grok Voice 2.0", provider: "xAI", modality: "voice" },

  // Music — the two that were sitting under voice while it was still called
  // audio, plus Lyria's clip model from the same published list Pro came from.
  //
  // No duration, even though a track has one: ElevenLabs takes a length in
  // milliseconds and Lyria's own bounds are not in the model list, so there is
  // no enumerated set to put in a menu. It arrives when those are read, the same
  // rule the rest of this catalogue is held to.
  { id: "lyria-3-pro-preview", name: "Lyria 3 Pro", provider: "Google", modality: "music" },
  { id: "lyria-3-clip-preview", name: "Lyria 3 Clip", provider: "Google", modality: "music" },
  { id: "music_v2", name: "ElevenLabs Music v2", provider: "ElevenLabs", modality: "music" },

  // Video — all three, and the lists differ per model rather than per provider:
  // Veo Lite drops 4k, and only Sora Pro reaches 1080p.
  {
    id: "veo-3.1-generate-preview",
    gateway: "google/veo-3.1-generate-001",
    name: "Veo 3.1",
    provider: "Google",
    modality: "video",
    resolutions: ["720p", "1080p", "4k"],
    // Veo's own lowercase `4k` next to an uppercase `1K` elsewhere is not a
    // typo: each is the string that provider's API accepts.
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 6, 8]
  },
  {
    id: "veo-3.1-lite-generate-preview",
    gateway: "google/veo-3.1-lite-generate-001",
    name: "Veo 3.1 Lite",
    provider: "Google",
    modality: "video",
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 6, 8]
  },
  {
    id: "sora-2",
    name: "Sora 2",
    provider: "OpenAI",
    modality: "video",
    // 1280×720 and 720×1280. The 1024×1792 pair it also takes is left out — see
    // the note on `resolutions` above.
    resolutions: ["720p"],
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 8, 12, 16, 20]
  },
  {
    id: "sora-2-pro",
    name: "Sora 2 Pro",
    provider: "OpenAI",
    modality: "video",
    // Pro is the only one of the two that reaches 1920×1080 / 1080×1920.
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16"],
    durations: [4, 8, 12, 16, 20]
  },
  {
    id: "grok-imagine-video-1.5",
    gateway: "xai/grok-imagine-video-1.5",
    name: "Grok Imagine Video 1.5",
    provider: "xAI",
    modality: "video",
    resolutions: ["480p", "720p"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    // Grok takes any whole number of seconds from 1 to 15 and defaults to 6.
    // These are presets across that range, not the API's own list.
    durations: [4, 6, 8, 12, 15]
  },
  {
    // Same id caveat as Seedream above.
    id: "doubao-seedance-2-0",
    gateway: "bytedance/seedance-2.0",
    name: "Seedance 2.0",
    provider: "ByteDance",
    modality: "video",
    // Two API hosts publish this model's inputs and agree on the six ratios and
    // on 480p/720p; one of them additionally lists 1080p. Kept to what both say,
    // because the cost of offering a tier the endpoint rejects is a failed
    // request and the cost of omitting one is a menu row.
    resolutions: ["480p", "720p"],
    // Reordered from the published list so 16:9 leads: the first entry is what
    // the composer defaults to, and 21:9 is a deliberate choice rather than
    // something to hand someone who never opened the menu.
    aspectRatios: ["16:9", "9:16", "21:9", "4:3", "1:1", "3:4"],
    // 4 to 15 seconds, any whole number — presets across the range, as with Grok.
    durations: [4, 6, 8, 10, 12, 15]
  }
];

/**
 * The catalogue entry behind a stored `model` string, or undefined for one this
 * build no longer offers.
 *
 * Undefined is a real answer rather than an error: an asset row keeps the model
 * it was made with, and a model can be dropped from the catalogue while rows
 * that name it are still on someone's canvas — a retry of one of those has to
 * do something sensible rather than throw.
 */
export function findModel(id: string): ModelOption | undefined {
  return MODELS.find((model) => model.id === id);
}
