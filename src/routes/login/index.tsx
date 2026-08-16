import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import * as z from "zod";

import {
  AuthShell,
  INPUT_CLASS,
  LABEL_CLASS,
  LINK_CLASS,
  SECONDARY_CLASS,
  SUBMIT_CLASS
} from "#/components/block/auth-shell";
import { authClient } from "#/lib/auth-client";
import { sessionQueryOptions, VERIFIED_CALLBACK_URL } from "#/lib/session";

const DEFAULT_REDIRECT = "/projects";

const searchSchema = z.object({
  redirect: z.string().optional(),
  /** Written by the magic-link endpoint when its token is dead. */
  error: z.string().optional()
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
 * Which way in is on screen. Password is the default because it is the one that
 * needs no round trip through a mailbox; the other two are offered underneath
 * rather than as equal tabs, so the common case stays one form.
 */
type Method = "password" | "code" | "link";

/**
 * Which request is in flight. One state rather than a boolean per control: only
 * one may be running, and each has its own pending label — a shared boolean
 * would put "Redirecting…" on the Google button while it is the form that is
 * busy.
 */
type Pending = "password" | "google" | "send-code" | "code" | "send-link";

/**
 * better-auth's code for "the password was right, but this address has never
 * been confirmed". It is not a failure in the way a wrong password is: a fresh
 * verification link has just gone out, and the two passwordless methods below
 * would also settle it, because both of them verify on the way through.
 */
const EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED";

const METHOD_LINK_CLASS = `${LINK_CLASS} text-xs font-normal`;

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();

  const [method, setMethod] = useState<Method>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(
    // The one error that arrives in the URL rather than from a request: a magic
    // link that had already been used, or had expired.
    search.error ? "That sign-in link has expired. Ask for a new one below." : null
  );
  const [unverified, setUnverified] = useState<string | null>(null);
  /** Set once a code has been mailed, which is what swaps in the code field. */
  const [codeSent, setCodeSent] = useState(false);
  /** Set once a link has been mailed; the form is done at that point. */
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const address = email.trim().toLowerCase();

  function choose(next: Method) {
    setMethod(next);
    // Each method reports its own outcome, so nothing from the previous one
    // should still be on screen under a form it does not belong to.
    setError(null);
    setUnverified(null);
    setCodeSent(false);
    setLinkSent(null);
    setCode("");
  }

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

  async function signInWithPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // No control is clickable while a request is in flight, but pressing Enter
    // in a field submits the form without going through one.
    if (pending) return;

    setError(null);
    setUnverified(null);
    setPending("password");

    const { error: signInError } = await authClient.signIn.email({
      // A trailing space in an address is a typo, not part of it. The password is
      // passed through untouched — whitespace there is a character like any other.
      email: email.trim(),
      password,
      // Not used when the sign in succeeds; it is where the *verification* link
      // will point if this attempt is refused for an unconfirmed address, since
      // `sendOnSignIn` mails one from inside this same request.
      callbackURL: VERIFIED_CALLBACK_URL
    });

    if (signInError) {
      if (signInError.code === EMAIL_NOT_VERIFIED) {
        setUnverified(email.trim());
      } else {
        // better-auth answers an unknown address and a wrong password with the same
        // message, so showing it verbatim cannot be used to enumerate accounts.
        setError(signInError.message ?? "Could not sign you in. Please try again.");
      }

      setPending(null);

      return;
    }

    // `pending` stays set on the way out: the page is being navigated away from,
    // and clearing it would flash a live form for a frame first.
    await completeSignIn();
  }

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending || !address) return;

    setError(null);
    setPending("send-code");

    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email: address,
      type: "sign-in"
    });

    if (sendError) {
      setError(sendError.message ?? "Could not send the code. Please try again.");
      setPending(null);

      return;
    }

    setCodeSent(true);
    setPending(null);
  }

  async function signInWithCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending) return;

    setError(null);
    setPending("code");

    /**
     * This is the whole of it: a correct code creates the account if the
     * address is new, marks it verified either way, and signs in — so somebody
     * blocked a moment ago for an unverified address is through, and verified,
     * without a separate errand.
     */
    const { error: signInError } = await authClient.signIn.emailOtp({
      email: address,
      otp: code.trim()
    });

    if (signInError) {
      setError(signInError.message ?? "That code did not work. Ask for a new one.");
      setPending(null);

      return;
    }

    await completeSignIn();
  }

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending || !address) return;

    setError(null);
    setPending("send-link");

    const { error: sendError } = await authClient.signIn.magicLink({
      email: address,
      // Where the link lands once it has signed the person in, and where it
      // lands when the token is dead — this page, which reads `?error=` at the
      // top and says so.
      callbackURL: safeRedirect(search.redirect),
      errorCallbackURL: "/login"
    });

    if (sendError) {
      setError(sendError.message ?? "Could not send the link. Please try again.");
      setPending(null);

      return;
    }

    setLinkSent(address);
    setPending(null);
  }

  async function signInWithGoogle() {
    if (pending) return;

    setError(null);
    setUnverified(null);
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

  const emailField = (
    <div>
      <label htmlFor={emailId} className={LABEL_CLASS}>
        Email
      </label>
      {/* Autofill is off on the password pair. Worth knowing what that does and
          does not buy: browsers treat `off` as a hint on a sign-in form rather
          than an instruction, so a built-in password manager may still offer to
          fill these — nothing in a page can stop that. */}
      <input
        id={emailId}
        type="email"
        name="email"
        autoComplete="email"
        placeholder="you@example.com"
        required={true}
        readOnly={pending !== null || codeSent}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className={INPUT_CLASS}
      />
    </div>
  );

  return (
    <AuthShell
      title="Sign in"
      description="Continue to your projects."
      error={error}
      notice={
        unverified ? (
          <>
            Confirm <strong className="text-neutral-900 dark:text-neutral-50">{unverified}</strong>{" "}
            before signing in — we just sent a fresh link. Or use a code instead: that signs you in
            and confirms the address in one step.
          </>
        ) : linkSent ? (
          <>
            A sign-in link is on its way to{" "}
            <strong className="text-neutral-900 dark:text-neutral-50">{linkSent}</strong>. It works
            once and expires in 10 minutes.
          </>
        ) : null
      }
      footer={
        <>
          New here?{" "}
          <Link to="/signup" className={LINK_CLASS}>
            Create an account
          </Link>
        </>
      }
    >
      {method === "password" ? (
        <form onSubmit={signInWithPassword} className="mt-6 flex flex-col gap-4">
          {emailField}

          <div>
            {/* The label and the way out of a forgotten password on one line:
                the link belongs to this field, and putting it here is what
                stops it from reading as another way to submit the form. */}
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={passwordId} className={LABEL_CLASS}>
                Password
              </label>
              <Link to="/forgot-password" className={METHOD_LINK_CLASS}>
                Forgot password?
              </Link>
            </div>
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
            aria-busy={pending === "password" || undefined}
            className={SUBMIT_CLASS}
          >
            {pending === "password" ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : null}

      {method === "code" ? (
        // Two forms rather than one with a branch: the first submits an address
        // and the second submits a code, and a single handler switching on
        // `codeSent` would make Enter mean different things in the same field.
        <form onSubmit={codeSent ? signInWithCode : sendCode} className="mt-6 flex flex-col gap-4">
          {emailField}

          {codeSent ? (
            <div>
              <label htmlFor={codeId} className={LABEL_CLASS}>
                Code
              </label>
              {/* `one-time-code` is what lets iOS and Android offer the code
                  straight from the notification, which is the entire reason to
                  prefer a code over a link on a phone. */}
              <input
                id={codeId}
                type="text"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                required={true}
                readOnly={pending !== null}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className={`${INPUT_CLASS} font-mono tracking-[0.3em]`}
              />
              <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                Sent to {address}. It expires in 10 minutes.
              </p>
            </div>
          ) : null}

          <button
            type="submit"
            aria-disabled={pending !== null}
            aria-busy={pending === "send-code" || pending === "code" || undefined}
            className={SUBMIT_CLASS}
          >
            {codeSent
              ? pending === "code"
                ? "Signing in…"
                : "Sign in"
              : pending === "send-code"
                ? "Sending…"
                : "Email me a code"}
          </button>
        </form>
      ) : null}

      {method === "link" && !linkSent ? (
        <form onSubmit={sendLink} className="mt-6 flex flex-col gap-4">
          {emailField}

          <button
            type="submit"
            aria-disabled={pending !== null}
            aria-busy={pending === "send-link" || undefined}
            className={SUBMIT_CLASS}
          >
            {pending === "send-link" ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      ) : null}

      {/* The other ways in. Laid out as prose rather than as buttons, because
          they are a change of method and not a second submit — three
          full-width buttons stacked would read as three things to press. */}
      <p className="mt-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
        {method !== "password" ? (
          <button type="button" onClick={() => choose("password")} className={METHOD_LINK_CLASS}>
            Use a password
          </button>
        ) : null}
        {method !== "code" ? (
          <>
            {method !== "password" ? <span aria-hidden={true}> · </span> : null}
            <button type="button" onClick={() => choose("code")} className={METHOD_LINK_CLASS}>
              Email me a code
            </button>
          </>
        ) : null}
        {method !== "link" ? (
          <>
            <span aria-hidden={true}> · </span>
            <button type="button" onClick={() => choose("link")} className={METHOD_LINK_CLASS}>
              Email me a link
            </button>
          </>
        ) : null}
      </p>

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
        className={SECONDARY_CLASS}
      >
        <GoogleLogo />
        {pending === "google" ? "Redirecting…" : "Continue with Google"}
      </button>
    </AuthShell>
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
