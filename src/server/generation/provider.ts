import type { AssetKind } from "#/db/schema";
import { findModel } from "#/lib/models";
import type { ResolvedGateway } from "#/server/generation/gateway";
import { gatewayProvider } from "#/server/generation/gateway-provider";
import type { GatewayCall } from "#/server/generation/metering";
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
  /**
   * What the call to the Gateway was, for the meter. Absent from the sample
   * provider, which does not make one.
   *
   * Carried back on the result rather than written from inside the provider,
   * because the provider is the one part of this pipeline that touches no
   * database — keeping it a pure request-to-bytes function is what lets a new
   * backend be written without knowing that billing exists.
   */
  call?: GatewayCall;
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
 * is there a gateway to call, does the catalogue know this model, and does the
 * Gateway serve it.
 *
 * The gateway is passed in rather than looked up, because *which* one is now an
 * organization-level fact — its own key or the system's — and resolving it
 * costs a database read. The caller does that once per generation and hands the
 * answer to everything downstream, so a single generation cannot end up making
 * its media call on one key and its naming call on another.
 *
 * Any "no" lands on the sample provider, and that is a feature rather than a
 * consolation. A fresh checkout with no key still has a canvas that fills with
 * files, so the whole pipeline above this seam — rows, R2, serving, the node
 * resolving — can be worked on without an account anywhere. The cost is that a
 * stand-in file is not obviously a stand-in, which is why the catalogue says
 * outright which entries are real.
 */
export function getProvider(model: string, resolved: ResolvedGateway | null): GenerationProvider {
  const entry = findModel(model);

  if (!resolved || !entry?.gateway || !GATEWAY_MODALITIES.has(entry.modality)) {
    return sampleProvider;
  }

  return gatewayProvider(entry, resolved.gateway);
}
