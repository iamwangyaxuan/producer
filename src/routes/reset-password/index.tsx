import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import * as z from "zod";

import {
  AuthShell,
  INPUT_CLASS,
  LABEL_CLASS,
  LINK_CLASS,
  SUBMIT_CLASS
} from "#/components/block/auth-shell";
import { authClient } from "#/lib/auth-client";
import { sessionQueryOptions } from "#/lib/session";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Both are written by better-auth's `/reset-password/:token` redirect: it hands
 * back `token` when the link is good and `error` when it is dead, never both.
 * Optional on both sides because someone can also arrive here by typing the
 * path, which is neither case.
 */
const searchSchema = z.object({
  token: z.string().optional(),
  error: z.string().optional()
});

export const Route = createFileRoute("/reset-password/")({
  validateSearch: searchSchema,
  component: RouteComponent
});

function RouteComponent() {
  const { token, error: linkError } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const passwordId = useId();
  const confirmId = useId();

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * A dead link and a bare visit both end here, and both are answered the same
   * way: there is no token, so there is nothing this page can do except send
   * the person back for a fresh one.
   */
  if (!token) {
    return (
      <AuthShell
        title="This link has expired"
        description={
          linkError
            ? "Reset links are good for one hour and can only be used once. Ask for a new one and it will work."
            : "Open the link from the reset email to choose a new password."
        }
        footer={
          <Link to="/forgot-password" className={LINK_CLASS}>
            Send a new link
          </Link>
        }
      />
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending) return;

    // Checked here and nowhere else: the server has no second field to compare
    // against, so this one is genuinely the client's job. It guards against a
    // typo locking someone out of the account they were just recovering.
    if (password !== confirmation) {
      setError("Those two passwords do not match.");

      return;
    }

    setError(null);
    setPending(true);

    const { error: resetError } = await authClient.resetPassword({
      newPassword: password,
      token
    });

    if (resetError) {
      setError(resetError.message ?? "Could not reset your password. Please try again.");
      setPending(false);

      return;
    }

    /**
     * Straight to sign in rather than into the app: `revokeSessionsOnPasswordReset`
     * has just invalidated every session on the account, including any this
     * browser held, so there is nothing to be signed in with.
     *
     * The cached session goes with it. Every route guard reads that cache
     * through `ensureQueryData`, which resolves from it whenever it holds
     * anything at all — a stale entry here would let the app believe this
     * browser is still signed in.
     */
    queryClient.removeQueries({ queryKey: sessionQueryOptions().queryKey });

    await navigate({ to: "/login", search: { redirect: undefined }, replace: true });
  }

  return (
    <AuthShell
      title="Choose a new password"
      description="Setting it signs out every other device on the account."
      error={error}
      footer={
        <Link to="/login" className={LINK_CLASS}>
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <div>
          <label htmlFor={passwordId} className={LABEL_CLASS}>
            New password
          </label>
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

        <div>
          <label htmlFor={confirmId} className={LABEL_CLASS}>
            Confirm password
          </label>
          <input
            id={confirmId}
            type="password"
            name="confirmPassword"
            autoComplete="new-password"
            required={true}
            readOnly={pending}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>

        <button
          type="submit"
          aria-disabled={pending}
          aria-busy={pending || undefined}
          className={SUBMIT_CLASS}
        >
          {pending ? "Saving…" : "Set new password"}
        </button>
      </form>
    </AuthShell>
  );
}
