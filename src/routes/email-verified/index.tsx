import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import * as z from "zod";

import { AuthShell, LINK_CLASS, SUBMIT_CLASS } from "#/components/block/auth-shell";
import { sessionQueryOptions } from "#/lib/session";

/**
 * Written by better-auth's `/verify-email` redirect when the token is dead —
 * expired, already used, or tampered with. Success arrives with no search
 * params at all.
 */
const searchSchema = z.object({
  error: z.string().optional()
});

/**
 * Where a verification link ends up.
 *
 * It exists because the alternative — pointing `callbackURL` straight at
 * `/projects` — has no answer for the half of the cases that fail. A dead token
 * redirects here too, and behind the `_auth` guard that would have become a
 * silent bounce to the sign-in page with nothing said about why.
 */
export const Route = createFileRoute("/email-verified/")({
  validateSearch: searchSchema,
  component: RouteComponent
});

function RouteComponent() {
  const { error } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [entering, setEntering] = useState(false);

  /**
   * `autoSignInAfterVerification` has already set the session cookie by the
   * time this renders, but the cached session is whatever this tab last read —
   * `null`, if the link was opened in a window that had never signed in. Every
   * route guard resolves that cache through `ensureQueryData`, which answers
   * from it stale or not, so without this refetch the button below would bounce
   * straight back to sign in.
   *
   * `refetchType: "all"` because nothing here subscribes to the query: plain
   * invalidation would only mark the cached `null` stale and leave it in place.
   */
  useEffect(() => {
    if (error) return;

    void queryClient.invalidateQueries({
      queryKey: sessionQueryOptions().queryKey,
      refetchType: "all"
    });
  }, [error, queryClient]);

  if (error) {
    return (
      <AuthShell
        title="This link has expired"
        description="Verification links can only be used once. Signing in again sends a fresh one straight away."
        footer={
          <Link to="/login" className={LINK_CLASS}>
            Back to sign in
          </Link>
        }
      />
    );
  }

  return (
    <AuthShell
      title="Email verified"
      description="Your address is confirmed and you are signed in."
      footer={
        <Link to="/login" className={LINK_CLASS}>
          Use a different account
        </Link>
      }
    >
      <button
        type="button"
        onClick={() => {
          setEntering(true);
          void navigate({ to: "/projects", replace: true });
        }}
        aria-disabled={entering}
        aria-busy={entering || undefined}
        className={`${SUBMIT_CLASS} mt-6`}
      >
        {entering ? "Opening…" : "Go to your projects"}
      </button>
    </AuthShell>
  );
}
