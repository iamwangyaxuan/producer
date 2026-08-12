import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { auth } from "./auth";
import { authClient } from "./auth-client";

export const fetchSession = createServerFn({ method: "GET" }).handler(async () => {
  return await auth.api.getSession({ headers: getRequest().headers });
});

/**
 * Shared between the route guard and the login page so a single request only
 * resolves the session once, and SSR hands the result to the client.
 */
export function sessionQueryOptions() {
  return queryOptions({
    queryKey: ["session"],
    queryFn: ({ signal }) => fetchSession({ signal })
  });
}

/**
 * The other end of the session's life. Shaped like the project mutations so a
 * caller gets `isPending` and `error` to render — signing out is a request like
 * any other, and it can fail.
 *
 * Nothing is done optimistically: while the request is in flight the session is
 * still real, and a menu that has already emptied the screen would be lying
 * about a revocation the server has not agreed to yet.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut();

      // better-auth reports a failed revocation in the payload rather than by
      // rejecting, so this is what turns it into the mutation's `error` instead
      // of a "success" that leaves the user signed in.
      if (error) throw new Error(error.message ?? "Could not sign you out. Please try again.");
    },
    onSuccess: async () => {
      // The cookie is gone, but the router's guards still read the session
      // through `ensureQueryData`, which resolves from the cache whenever it
      // holds anything at all — stale or not. Leaving the entry in place would
      // make `/login` believe this browser is signed in and bounce it straight
      // back into the app.
      queryClient.removeQueries({ queryKey: sessionQueryOptions().queryKey });

      try {
        await navigate({ to: "/login", replace: true });
      } finally {
        // Everything else — the project lists, the project behind the studio —
        // was read as this user and must not be painted for the next one. It is
        // dropped *after* the navigation rather than before it, so the page
        // being left does not first re-render itself empty on the way out, and
        // in a `finally` so a navigation that never lands cannot leave the
        // previous account's rows sitting in the cache.
        queryClient.clear();
      }
    }
  });
}
