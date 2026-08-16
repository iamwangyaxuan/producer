import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireBillingAccess } from "#/lib/billing-access";
import {
  GatewayKeyError,
  readGatewayKeyStatus,
  removeGatewayKey,
  saveGatewayKey
} from "#/server/generation/gateway-key";

/**
 * Installing an organization's own AI Gateway key, from the browser.
 *
 * The key travels in exactly one direction. It goes up once, in the body of a
 * POST, and is never sent back — every read here answers with four characters
 * and a date. There is no "show key" and no edit-in-place, because both need
 * the plaintext on a screen, and a credential that can be displayed is one that
 * ends up in a screenshot, a support thread, or a bug report.
 *
 * Guarded by the same `BILLING_ROLES` as the wallet, and for a stronger reason
 * than symmetry: installing a key moves who pays for every generation in the
 * organization, which is the most consequential billing switch in the product.
 */

export interface GatewayKeyState {
  /** Null when the organization is on the system key. */
  installed: { preview: string; verifiedAt: string; updatedAt: string } | null;
  /** Whether the viewer is allowed to change it. */
  canManage: boolean;
}

const NO_KEY: GatewayKeyState = { installed: null, canManage: false };

export const fetchGatewayKey = createServerFn({ method: "GET" }).handler(
  async (): Promise<GatewayKeyState> => {
    const viewer = await requireBillingAccess().catch(() => null);

    if (!viewer) return NO_KEY;

    const status = await readGatewayKeyStatus(viewer.organizationId);

    return {
      installed: status
        ? {
            preview: status.preview,
            verifiedAt: status.verifiedAt.toISOString(),
            updatedAt: status.updatedAt.toISOString()
          }
        : null,
      canManage: true
    };
  }
);

export function gatewayKeyQueryOptions(organizationId: string | null | undefined) {
  return queryOptions({
    queryKey: ["credits", organizationId ?? "none", "gateway-key"],
    queryFn: ({ signal }) => fetchGatewayKey({ signal }),
    staleTime: 30_000
  });
}

const saveInput = z.object({
  /**
   * Bounded, but not pattern-matched. Vercel's keys look like `vck_…` today and
   * a regex written from that would start rejecting valid keys the moment the
   * prefix changes — the Gateway itself is the authority on whether a key is
   * good, and it is asked before anything is stored.
   */
  apiKey: z.string().trim().min(8).max(512)
});

export const saveGatewayKeyFn = createServerFn({ method: "POST" })
  .validator(saveInput)
  .handler(async ({ data }): Promise<GatewayKeyState> => {
    const viewer = await requireBillingAccess();

    try {
      const status = await saveGatewayKey(viewer.organizationId, viewer.userId, data.apiKey);

      return {
        installed: {
          preview: status.preview,
          verifiedAt: status.verifiedAt.toISOString(),
          updatedAt: status.updatedAt.toISOString()
        },
        canManage: true
      };
    } catch (error) {
      // `GatewayKeyError` messages were written for the person pasting the key
      // and go through as they are. Anything else is logged and replaced —
      // whatever it carries came from a code path holding a live credential,
      // and none of it should reach a screen.
      if (error instanceof GatewayKeyError) throw error;

      console.error("could not save an organization gateway key", error);

      throw new GatewayKeyError("Could not save that key. Please try again.");
    }
  });

export const removeGatewayKeyFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<GatewayKeyState> => {
    const viewer = await requireBillingAccess();

    await removeGatewayKey(viewer.organizationId);

    return { installed: null, canManage: true };
  }
);

/**
 * Both mutations invalidate the whole `credits` prefix rather than just this
 * key's entry: installing or removing a key changes whether generations are
 * billed at all, so the balance card, the composer's price and the usage report
 * are all answering a different question afterwards.
 */
export function useSaveGatewayKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { apiKey: string }) => saveGatewayKeyFn({ data: variables }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["credits"] });
    }
  });
}

export function useRemoveGatewayKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => removeGatewayKeyFn(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["credits"] });
    }
  });
}
