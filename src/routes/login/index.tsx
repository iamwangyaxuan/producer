import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import * as z from "zod";

import { authClient } from "#/lib/auth-client";
import { sessionQueryOptions } from "#/lib/session";

const DEFAULT_REDIRECT = "/projects";

const searchSchema = z.object({
  redirect: z.string().optional()
});

/**
 * Only same-origin paths are honoured, so a crafted `?redirect=` cannot bounce
 * a freshly signed-in user to another site.
 */
function safeRedirect(target: string | undefined) {
  if (!target?.startsWith("/") || target.startsWith("//")) return DEFAULT_REDIRECT;

  return target;
}

export const Route = createFileRoute("/login/")({
  validateSearch: searchSchema,
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions());

    if (session) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: RouteComponent
});

/**
 * Which of the two sign in paths is waiting on the server. One state rather than
 * a boolean per button: only one request may be in flight, and the buttons have
 * different pending labels — a shared boolean would put "Redirecting…" on the
 * Google button while it is the form that is busy.
 */
type PendingMethod = "email" | "google";

const LABEL_CLASS = "block text-sm font-medium text-neutral-700 dark:text-neutral-300";

/**
 * `read-only` rather than `disabled` while a request is in flight, for the
 * reason the buttons below use `aria-disabled`: a disabled control drops focus,
 * which leaves a keyboard or screen reader user back at the top of the document
 * at the exact moment there is something to tell them.
 *
 * Deliberately without `transition`. Tailwind's bare one covers `border-color`,
 * and these two fields sit one above the other: moving between them would fade
 * the border of the field being left out over 150ms while the border of the
 * field being entered faded in, so for that moment the *old* field is the
 * brighter of the two and the focus reads as lagging a step behind the pointer.
 * A focus indicator is the one thing that has to land at once.
 */
const INPUT_CLASS = [
  "mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2",
  "text-sm text-neutral-900 outline-hidden placeholder:text-neutral-400",
  "focus-visible:border-neutral-900 read-only:opacity-60",
  "dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50",
  "dark:placeholder:text-neutral-500 dark:focus-visible:border-neutral-400"
].join(" ");

/**
 * `aria-disabled` plus `pointer-events-none` instead of the `disabled`
 * attribute: the button keeps its focus while the request is in flight, and the
 * submit handler guards the keyboard path that a non-disabled submit button
 * still leaves open.
 */
const BUTTON_BASE_CLASS = [
  "flex w-full items-center justify-center gap-3 rounded-lg px-4 py-2.5",
  // `transition-colors`, the way the shared button does it, rather than the bare
  // `transition`: that one also lists `pointer-events`, a discrete property that
  // flips half way through — the row below would keep taking clicks for 75ms
  // after it had been told to stop.
  "text-sm font-medium transition-colors",
  "focus-visible:outline-2 focus-visible:outline-offset-2",
  "aria-disabled:pointer-events-none aria-disabled:opacity-60"
].join(" ");

const SUBMIT_CLASS = [
  BUTTON_BASE_CLASS,
  "bg-neutral-900 text-white hover:bg-neutral-800 focus-visible:outline-neutral-900",
  "dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-white dark:focus-visible:outline-neutral-50"
].join(" ");

const GOOGLE_CLASS = [
  BUTTON_BASE_CLASS,
  "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50",
  "focus-visible:outline-neutral-900",
  "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:bg-neutral-800",
  "dark:focus-visible:outline-neutral-50"
].join(" ");

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const emailId = useId();
  const passwordId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMethod | null>(null);

  /**
   * The credentials are accepted and the session cookie is already set by the
   * time this runs, so all that is left is to make the app agree.
   */
  async function completeSignIn() {
    // The cookie is set, but `sessionQueryOptions` still holds the `null` this
    // page was rendered with, and every route guard reads it through
    // `ensureQueryData` — which resolves straight from the cache whenever it
    // holds anything at all, stale or not. Without this refetch the redirect
    // target would bounce the signed-in user right back here.
    //
    // `refetchType: "all"` because nothing on this page subscribes to the query:
    // the default only refetches *active* ones, so plain invalidation would mark
    // the cached `null` stale and leave it sitting there to be read.
    await queryClient.invalidateQueries({
      queryKey: sessionQueryOptions().queryKey,
      refetchType: "all"
    });

    // `replace`, so the back button leaves the app rather than returning to a
    // login page that now only redirects forwards again.
    await navigate({ href: safeRedirect(search.redirect), replace: true });
  }

  async function signInWithEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Neither button is clickable while a request is in flight, but pressing
    // Enter in a field submits the form without going through one.
    if (pending) return;

    setError(null);
    setPending("email");

    const { error: signInError } = await authClient.signIn.email({
      // A trailing space in an address is a typo, not part of it. The password is
      // passed through untouched — whitespace there is a character like any other.
      email: email.trim(),
      password
    });

    if (signInError) {
      // better-auth answers an unknown address and a wrong password with the same
      // message, so showing it verbatim cannot be used to enumerate accounts.
      setError(signInError.message ?? "Could not sign you in. Please try again.");
      setPending(null);

      return;
    }

    // `pending` stays set on the way out: the page is being navigated away from,
    // and clearing it would flash a live form for a frame first.
    await completeSignIn();
  }

  async function signInWithGoogle() {
    if (pending) return;

    setError(null);
    setPending("google");

    // On success better-auth redirects the browser to Google, so the pending
    // state is only reset when something went wrong.
    const { error: signInError } = await authClient.signIn.social({
      provider: "google",
      callbackURL: safeRedirect(search.redirect),
      errorCallbackURL: "/login"
    });

    if (signInError) {
      setError(signInError.message ?? "Could not start Google sign in. Please try again.");
      setPending(null);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">Sign in</h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          Continue to your projects.
        </p>

        {/* Above the form rather than beside one field: the message belongs to
            whichever of the two methods was tried, and only one of them has
            fields at all. */}
        {error ? (
          <p
            role="alert"
            className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400"
          >
            {error}
          </p>
        ) : null}

        <form onSubmit={signInWithEmail} className="mt-6 flex flex-col gap-4">
          <div>
            <label htmlFor={emailId} className={LABEL_CLASS}>
              Email
            </label>
            {/* Autofill is off on both fields. Worth knowing what that does and
                does not buy: browsers treat `off` as a hint on a sign-in form
                rather than an instruction, so a built-in password manager may
                still offer to fill these — nothing in a page can stop that. */}
            <input
              id={emailId}
              type="email"
              name="email"
              autoComplete="off"
              placeholder="you@example.com"
              required={true}
              readOnly={pending !== null}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor={passwordId} className={LABEL_CLASS}>
              Password
            </label>
            {/* No `minLength`: the server applies the password policy and answers
                a short password with the same "invalid email or password" as a
                wrong one. Enforcing it here would tell an attacker the shape of
                the policy, and would lock out accounts created before it. */}
            <input
              id={passwordId}
              type="password"
              name="password"
              autoComplete="off"
              required={true}
              readOnly={pending !== null}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <button
            type="submit"
            aria-disabled={pending !== null}
            aria-busy={pending === "email" || undefined}
            className={SUBMIT_CLASS}
          >
            {pending === "email" ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div aria-hidden={true} className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          <span className="text-xs text-neutral-400 dark:text-neutral-500">or</span>
          <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        </div>

        <button
          type="button"
          onClick={signInWithGoogle}
          aria-disabled={pending !== null}
          aria-busy={pending === "google" || undefined}
          className={GOOGLE_CLASS}
        >
          <GoogleLogo />
          {pending === "google" ? "Redirecting…" : "Continue with Google"}
        </button>
      </div>
    </main>
  );
}

function GoogleLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="size-4.5">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
