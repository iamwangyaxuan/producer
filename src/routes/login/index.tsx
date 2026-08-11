import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
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

function RouteComponent() {
  const search = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  async function signInWithGoogle() {
    setError(null);
    setIsSigningIn(true);

    // On success better-auth redirects the browser to Google, so the pending
    // state is only reset when something went wrong.
    const { error: signInError } = await authClient.signIn.social({
      provider: "google",
      callbackURL: safeRedirect(search.redirect),
      errorCallbackURL: "/login"
    });

    if (signInError) {
      setError(signInError.message ?? "Could not start Google sign in. Please try again.");
      setIsSigningIn(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 dark:bg-neutral-950">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">Sign in</h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          Continue to your projects with your Google account.
        </p>

        <button
          type="button"
          onClick={signInWithGoogle}
          disabled={isSigningIn}
          className="mt-8 flex w-full items-center justify-center gap-3 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-900 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:bg-neutral-800"
        >
          <GoogleLogo />
          {isSigningIn ? "Redirecting…" : "Continue with Google"}
        </button>

        {error ? (
          <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
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
