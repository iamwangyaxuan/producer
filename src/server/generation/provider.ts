import type { Modality } from "#/components/block/studio/ai-composer";

import { sampleProvider } from "#/server/generation/sample-provider";

/**
 * The seam a real model provider slots into. Everything above this interface —
 * the asset row, the R2 write, the serving URL — is provider-agnostic;
 * everything below it is one vendor's API. Swapping the stub for a real
 * integration means implementing `run` and changing `getProvider`, nothing
 * else.
 */

export interface GenerationRequest {
  modality: Modality;
  prompt: string;
  /** Catalogue id, e.g. "gpt-image-2" — one flat namespace across vendors. */
  model: string;
  resolution?: string;
  aspectRatio?: string;
  /** Requested seconds, video only. */
  duration?: number;
}

export interface GenerationResult {
  body: ReadableStream | ArrayBuffer;
  /** e.g. "image/jpeg" — becomes the asset row's mimeType. */
  contentType: string;
  /** Required when body is a stream — R2 needs a known length to accept one. */
  contentLength?: number;
}

export interface GenerationProvider {
  run(request: GenerationRequest, signal?: AbortSignal): Promise<GenerationResult>;
}

/**
 * Always the stub today. A real integration replaces this lookup with a
 * per-model routing table; the call sites do not change.
 */
export function getProvider(_model: string): GenerationProvider {
  return sampleProvider;
}
