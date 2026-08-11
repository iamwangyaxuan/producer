import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { auth } from "./auth";

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
