import type { Modality } from "#/components/block/studio/ai-composer";
import type { AssetKind } from "#/db/schema";
import { sampleProvider } from "#/server/generation/sample-provider";

/**
 * The seam a real model provider slots into. Everything above this interface —
 * the asset row, the R2 write, the serving URL — is provider-agnostic;
 * everything below it is one vendor's API. Swapping the stub for a real
 * integration means implementing `run` and changing `getProvider`, nothing
 * else.
 */

/**
 * A file the prompt refers to, as something a vendor's API can actually reach.
 *
 * The URL is presigned and short-lived, which is the whole reason it is minted
 * server-side and passed down rather than assembled from an asset id: the
 * provider fetches from its own infrastructure, carrying none of this app's
 * cookies, so anything requiring a session would come back a 404 to it. That
 * also makes this the point where bytes leave the tenant boundary — the link
 * works for whoever holds it until it expires.
 */
export interface GenerationReference {
  url: string;
  /** What the URL answers with, so a vendor that routes by type knows before fetching. */
  mimeType: string;
  kind: AssetKind;
  /** Slot the input fills, e.g. "source_image" — null when unlabelled. */
  role: string | null;
}

export interface GenerationRequest {
  modality: Modality;
  prompt: string;
  /** Catalogue id, e.g. "gpt-image-2" — one flat namespace across vendors. */
  model: string;
  resolution?: string;
  aspectRatio?: string;
  /** Requested seconds, video only. */
  duration?: number;
  /** Files the prompt was written against, in the order they were attached. */
  references: readonly GenerationReference[];
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
