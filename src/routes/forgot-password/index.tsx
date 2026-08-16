import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { FormEvent } from "react";

import {
  AuthShell,
  INPUT_CLASS,
  LABEL_CLASS,
  LINK_CLASS,
  SUBMIT_CLASS
} from "#/components/block/auth-shell";
import { authClient } from "#/lib/auth-client";
import { RESET_PASSWORD_URL } from "#/lib/session";

/**
 * Asking for a reset link.
 *
 * No `beforeLoad` guard bouncing signed-in visitors away, unlike sign in and
 * sign up: someone can be signed in on this device and still have forgotten the
 * password they need on another one.
 */
export const Route = createFileRoute("/forgot-password/")({
  component: RouteComponent
});

function RouteComponent() {
  const emailId = useId();

  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending) return;

    setError(null);
    setPending(true);

    const { error: resetError } = await authClient.requestPasswordReset({
      email: email.trim().toLowerCase(),
      // Where better-auth sends the browser once it has checked the token is
      // real and unexpired; it appends `?token=…`, or `?error=INVALID_TOKEN`.
      redirectTo: RESET_PASSWORD_URL
    });

    // Only transport failures land here. An address with no account behind it
    // is answered exactly like one that has — better-auth even generates a
    // throwaway token and does a dummy lookup so the two take the same time —
    // which is why the screen below never says whether the account exists.
    if (resetError) {
      setError(resetError.message ?? "Could not send the reset link. Please try again.");
      setPending(false);

      return;
    }

    setSent(true);
    setPending(false);
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        description="If that address has an account, a link to choose a new password is on its way."
        notice="The link is good for one hour. Until you use it, your current password keeps working."
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
      title="Forgot your password?"
      description="Enter the address you signed up with and we will send a link to reset it."
      error={error}
      footer={
        <Link to="/login" className={LINK_CLASS}>
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={requestReset} className="mt-6 flex flex-col gap-4">
        <div>
          <label htmlFor={emailId} className={LABEL_CLASS}>
            Email
          </label>
          <input
            id={emailId}
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            required={true}
            readOnly={pending}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>

        <button
          type="submit"
          aria-disabled={pending}
          aria-busy={pending || undefined}
          className={SUBMIT_CLASS}
        >
          {pending ? "Sending…" : "Send reset link"}
        </button>
      </form>
    </AuthShell>
  );
}
