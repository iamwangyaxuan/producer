import type { AssetKind } from "#/db/schema";
import { findModel } from "#/lib/models";
import { getGateway } from "#/server/generation/gateway";
import { gatewayProvider } from "#/server/generation/gateway-provider";
import { sampleProvider } from "#/server/generation/sample-provider";

/**
 * The seam a model provider slots into. Everything above this interface — the
 * asset row, the R2 write, the serving URL — is provider-agnostic; everything
 * below it is the AI Gateway, or the stub that stands in where the Gateway has
 * nothing to offer.
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
  modality: AssetKind;
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
 * Modalities the Gateway can generate. Music is absent because the Gateway has
 * no music models — not a missing integration, an empty shelf.
 */
const GATEWAY_MODALITIES: ReadonlySet<AssetKind> = new Set<AssetKind>(["image", "video", "voice"]);

/**
 * Which backend answers for a model, decided by three questions in order:
 * is there a key, does the catalogue know this model, and does the Gateway
 * serve it.
 *
 * Any "no" lands on the sample provider, and that is a feature rather than a
 * consolation. A fresh checkout with no key still has a canvas that fills with
 * files, so the whole pipeline above this seam — rows, R2, serving, the node
 * resolving — can be worked on without an account anywhere. The cost is that a
 * stand-in file is not obviously a stand-in, which is why the catalogue says
 * outright which entries are real.
 */
export function getProvider(model: string): GenerationProvider {
  const entry = findModel(model);

  if (!entry?.gateway || !GATEWAY_MODALITIES.has(entry.modality) || !getGateway()) {
    return sampleProvider;
  }

  return gatewayProvider(entry);
}
