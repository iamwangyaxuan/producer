import { aspectRatioValue } from "#/lib/aspect-ratio";

import type {
  GenerationProvider,
  GenerationRequest,
  GenerationResult
} from "#/server/generation/provider";
import type { Modality } from "#/components/block/studio/ai-composer";

/**
 * Stand-in results for a generation backend that does not exist yet.
 *
 * Nothing here calls a model. Each request waits a plausible amount of time
 * and then fetches a real file from an open library, so the pipeline being
 * built — an asset row, bytes landing in R2, a node resolving into served
 * content — runs end to end against real network behaviour. This is the
 * server-side descendant of the old client-side `sample-media` stub; when a
 * real provider arrives it replaces this file behind the same interface.
 *
 * Every URL below was checked to answer with the media type it claims. That is
 * worth doing rather than assuming: the sample bucket these lists would
 * otherwise have used, `storage.googleapis.com/gtv-videos-bucket`, is the
 * canonical one in a decade of tutorials and now answers 403.
 */

/** Lorem Picsum, which serves Unsplash photography by seed and size. */
const IMAGE_ORIGIN = "https://picsum.photos";

/** Blender's open movies (CC BY) as hosted by the W3C, plus MDN's CC0 footage. */
const VIDEOS = [
  "https://media.w3.org/2010/05/sintel/trailer.mp4",
  "https://media.w3.org/2010/05/bunny/trailer.mp4",
  "https://media.w3.org/2010/05/video/movie_300.mp4",
  "https://mdn.github.io/shared-assets/videos/flower.mp4",
  "https://mdn.github.io/shared-assets/videos/friday.mp4"
] as const;

/**
 * LibriVox readings on the Internet Archive — public domain, and speech rather
 * than sound effects, which is what a voice model would be answering with.
 */
const VOICE = [
  "https://archive.org/download/westminsteralice_rg_librivox/westminsteralice_00_saki_64kb.mp3",
  "https://archive.org/download/hislastbow_dr_1503_librivox/hislastbow_00_doyle_64kb.mp3",
  "https://archive.org/download/babysownaesop_2106_librivox/babysownaesop_01_crane_64kb.mp3"
] as const;

/** SoundHelix's algorithmically composed demo tracks, free to use. */
const MUSIC = [
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3"
] as const;

/**
 * How long each kind pretends to take. Roughly ordered the way real models are —
 * a still lands long before a clip does — and jittered so a burst of requests
 * does not resolve in lockstep, which is the one thing that would make the
 * placeholder read as fake at a glance.
 */
const LATENCY_MS: Record<Modality, number> = {
  image: 1400,
  voice: 1900,
  music: 2200,
  video: 3000
};

/**
 * Same prompt, same picture. A model that answered a repeated request with
 * something unrelated would be a strange one.
 */
function seedFrom(text: string) {
  let hash = 0;

  for (const char of text) {
    hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0;
  }

  return Math.abs(hash);
}

function pick<T>(list: readonly T[], seed: number) {
  return list[seed % list.length];
}

/**
 * A width that reads well on the canvas rather than the tier that was asked
 * for: requesting 4K from a placeholder service would cost seconds of transfer
 * to fill a box a few hundred pixels wide. The ratio is honoured, because that
 * is what the node was already sized to and a mismatch would show.
 */
const IMAGE_WIDTH = 960;

function sampleMediaUrl(request: GenerationRequest): string {
  const seed = seedFrom(`${request.model}:${request.prompt}`);

  switch (request.modality) {
    case "image": {
      const ratio = aspectRatioValue(request.aspectRatio) ?? 1;
      const height = Math.round(IMAGE_WIDTH / ratio);

      return `${IMAGE_ORIGIN}/seed/${seed}/${IMAGE_WIDTH}/${height}`;
    }
    case "video":
      return pick(VIDEOS, seed);
    case "voice":
      return pick(VOICE, seed);
    case "music":
      return pick(MUSIC, seed);
  }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const sampleProvider: GenerationProvider = {
  async run(request, signal): Promise<GenerationResult> {
    const base = LATENCY_MS[request.modality];

    await wait(base + Math.random() * base * 0.4, signal);

    const response = await fetch(sampleMediaUrl(request), { signal });

    if (!response.ok || !response.body) {
      throw new Error(`Sample media answered ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const lengthHeader = response.headers.get("content-length");

    // R2 refuses a stream of unknown length; the sample origins all send
    // Content-Length, but when one does not the file is small enough to hold.
    if (lengthHeader === null) {
      return { body: await response.arrayBuffer(), contentType };
    }

    return { body: response.body, contentType, contentLength: Number(lengthHeader) };
  }
};
