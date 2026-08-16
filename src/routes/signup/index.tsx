import { createFileRoute, Link, redirect } from "@tanstack/react-router";
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
import { sessionQueryOptions, VERIFIED_CALLBACK_URL } from "#/lib/session";

/**
 * better-auth's own minimum. Stated here, unlike on the sign-in form, and the
 * difference is deliberate: telling someone the rule *before* they choose a
 * password saves a round trip, while telling them at sign in would describe the
 * policy to an attacker and lock out accounts made before it existed.
 */
const MIN_PASSWORD_LENGTH = 8;

export const Route = createFileRoute("/signup/")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());

    if (session) throw redirect({ to: "/projects" });
  },
  component: RouteComponent
});

function RouteComponent() {
  const emailId = useId();
  const passwordId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The address the verification link went to; set only once it has been sent. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function signUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // The button is not clickable while the request is in flight, but pressing
    // Enter in a field submits the form without going through it.
    if (pending) return;

    setError(null);
    setPending(true);

    const address = email.trim().toLowerCase();

    const { error: signUpError } = await authClient.signUp.email({
      /**
       * Empty on purpose, and required by better-auth's schema rather than by
       * us. This form does not ask for a name — the address already carries a
       * usable one — and `databaseHooks.user.create.before` in `auth.ts` fills
       * a blank with the part before the `@`. That is the same thing the
       * passwordless doors do, so all three ways in produce the same shape of
       * account.
       */
      name: "",
      // A trailing space in an address is a typo, not part of it; lowercasing
      // matches what better-auth stores, so the address shown back on the next
      // screen is the one the mail actually went to.
      email: address,
      password,
      callbackURL: VERIFIED_CALLBACK_URL
    });

    if (signUpError) {
      setError(signUpError.message ?? "Could not create your account. Please try again.");
      setPending(false);

      return;
    }

    /**
     * No navigation, and no session either: with `requireEmailVerification` on,
     * better-auth deliberately does not sign a new account in — the address has
     * not been proved yet. So the form is replaced by the one instruction that
     * matters.
     *
     * This screen is also what an *existing* address gets, because sign up
     * answers the same way for both. That is the point: the form cannot be used
     * to find out who already has an account, and the person who really owns
     * the address is the one who finds out, in their inbox.
     */
    setSentTo(address);
    setPending(false);
  }

  if (sentTo) {
    return (
      <AuthShell
        title="Check your email"
        description={
          <>
            We sent a link to{" "}
            <strong className="text-neutral-900 dark:text-neutral-50">{sentTo}</strong>. Following
            it confirms the address and signs you in.
          </>
        }
        notice="Nothing arrived? Give it a minute, then check your spam folder — the link is what activates the account."
        footer={
          <>
            Already confirmed?{" "}
            <Link to="/login" className={LINK_CLASS}>
              Sign in
            </Link>
          </>
        }
      />
    );
  }

  return (
    <AuthShell
      title="Create an account"
      description="Start a workspace, or join one you have been invited to."
      error={error}
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className={LINK_CLASS}>
            Sign in
          </Link>
        </>
      }
    >
      {/* Two fields. There is no name here on purpose: the address already
          carries one, and a field somebody has to fill before they can start is
          a field worth removing. */}
      <form onSubmit={signUp} className="mt-6 flex flex-col gap-4">
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

        <div>
          <label htmlFor={passwordId} className={LABEL_CLASS}>
            Password
          </label>
          {/* `new-password` rather than `off`, so a password manager offers to
              generate and store one — which is the outcome worth encouraging on
              this form specifically. */}
          <input
            id={passwordId}
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required={true}
            readOnly={pending}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={`${passwordId}-hint`}
            className={INPUT_CLASS}
          />
          <p
            id={`${passwordId}-hint`}
            className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400"
          >
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        </div>

        <button
          type="submit"
          aria-disabled={pending}
          aria-busy={pending || undefined}
          className={SUBMIT_CLASS}
        >
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
