import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { auth } from "#/lib/auth";
import { authClient } from "#/lib/auth-client";
import { sessionQueryOptions } from "#/lib/session";

/**
 * The account itself: who you are, how you get in, and where you are signed in.
 *
 * Organization-independent, unlike everything else under `_dashboard` — this is
 * the one page whose answer does not change when the switcher does, which is
 * why its query is not keyed by an organization id.
 *
 * The reads go through `auth.api` rather than straight to the tables. Sessions
 * and linked accounts are better-auth's to describe, it already scopes them to
 * the caller's cookie, and reading them here with our own SQL would be a second
 * definition of "your account" that could disagree with the one doing the
 * authenticating.
 */

/** How the app names the providers better-auth reports. */
const PROVIDER_LABELS: Record<string, string> = {
  credential: "Password",
  google: "Google"
};

export interface ProfileSummary {
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  /** ISO — a `Date` does not survive the trip as one. */
  createdAt: string;
  /**
   * The providers linked to this account, already labelled. Passwordless
   * sign-ins are absent by design: a code or a link leaves no `account` row,
   * because there is nothing stored to sign in *with*.
   */
  signInMethods: string[];
  /**
   * Whether a password exists at all. It decides between two different forms —
   * changing one requires the old one, setting a first one cannot.
   */
  hasPassword: boolean;
  /** Including this one, which is why the page always says "other" devices. */
  sessionCount: number;
}

export const fetchProfile = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProfileSummary | null> => {
    const headers = getRequest().headers;
    const session = await auth.api.getSession({ headers });

    if (!session) return null;

    // Both are cookie-scoped by better-auth, so neither takes a user id from
    // anywhere: there is no shape of this request that reads another account.
    const [accounts, sessions] = await Promise.all([
      auth.api.listUserAccounts({ headers }),
      auth.api.listSessions({ headers })
    ]);

    const providers = accounts.map((account) => account.providerId);

    return {
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image ?? null,
      createdAt: new Date(session.user.createdAt).toISOString(),
      signInMethods: providers.map((provider) => PROVIDER_LABELS[provider] ?? provider),
      hasPassword: providers.includes("credential"),
      sessionCount: sessions.length
    };
  }
);

export function profileQueryOptions() {
  return queryOptions({
    queryKey: ["profile"],
    queryFn: ({ signal }) => fetchProfile({ signal }),
    staleTime: 30_000
  });
}

/**
 * Gives an account its first password.
 *
 * A server function because better-auth keeps `setPassword` off the client on
 * purpose: it is the one password write that does not ask for the old one, and
 * exposing it as a browser-callable endpoint would be a way to change a
 * password knowing only a session.
 *
 * The refusal below is what keeps that property here too. It runs only for an
 * account that has no `credential` row — the passwordless doors and Google
 * create none — so an account that already has a password can never reach it,
 * and must go through `changePassword` and prove the old one.
 */
const setPasswordInput = z.object({ newPassword: z.string().min(8).max(128) });

export const setInitialPassword = createServerFn({ method: "POST" })
  .validator(setPasswordInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const headers = getRequest().headers;
    const session = await auth.api.getSession({ headers });

    if (!session) throw new Error("Not signed in.");

    const accounts = await auth.api.listUserAccounts({ headers });

    if (accounts.some((account) => account.providerId === "credential")) {
      throw new Error("This account already has a password. Change it instead.");
    }

    await auth.api.setPassword({ body: { newPassword: data.newPassword }, headers });

    return { ok: true };
  });

/**
 * Renaming yourself.
 *
 * The refresh reaches further than this page: the name is also in the sidebar's
 * account menu, which reads it from the route context the `_auth` guard puts
 * there — not from this query.
 *
 * Which is why invalidating the session is not enough, and was the first thing
 * tried here. The guard resolves through `ensureQueryData`, and that hands back
 * whatever the cache holds *whether or not it is stale* — the same behaviour
 * `useSignOut` works around by removing the entry outright. Marking it stale
 * and re-running the router therefore re-read the old name and put it straight
 * back on screen. Removing it is not an option either: the guard is about to
 * read it, and a missing session is a redirect to the login page.
 */
export function useUpdateName() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: async (variables: { name: string }) => {
      const { error } = await authClient.updateUser({ name: variables.name });

      // better-auth reports failures in the payload rather than by rejecting.
      if (error) throw new Error(error.message ?? "Could not save that name.");
    },
    onSuccess: async (_result, variables) => {
      // Written into the cache rather than refetched. The guard reads through
      // `ensureQueryData`, which hands back whatever is cached whether or not
      // it is stale, so the entry has to *hold* the new name before the router
      // re-reads it — and the name is a value we already have, which makes a
      // round trip to fetch it back the slower way of being less certain.
      queryClient.setQueryData(sessionQueryOptions().queryKey, (previous) =>
        previous ? { ...previous, user: { ...previous.user, name: variables.name } } : previous
      );

      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      // Re-runs the guard, which rebuilds the context every page reads its
      // copy of the user from — including the sidebar's account menu.
      await router.invalidate();
    }
  });
}

/**
 * Changing a password you already have.
 *
 * `revokeOtherSessions` is on, matching what a reset does: somebody changing
 * their password is usually acting on a suspicion, and the one thing that would
 * make that pointless is leaving whoever prompted it still signed in.
 */
export function useChangePassword() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: { currentPassword: string; newPassword: string }) => {
      const { error } = await authClient.changePassword({
        currentPassword: variables.currentPassword,
        newPassword: variables.newPassword,
        revokeOtherSessions: true
      });

      if (error) throw new Error(error.message ?? "Could not change your password.");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    }
  });
}

export function useSetInitialPassword() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { newPassword: string }) => setInitialPassword({ data: variables }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    }
  });
}

/** Everywhere but here. The session doing the asking is deliberately kept. */
export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();

      if (error) throw new Error(error.message ?? "Could not sign out your other devices.");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    }
  });
}
