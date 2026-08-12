import handler from "@tanstack/react-start/server-entry";
import { routePartykitRequest } from "partyserver";

import { canAccessProjectCanvas } from "#/server/canvas-access";

/**
 * Exported from the entry because that is what registers it with the runtime:
 * a Durable Object class the worker does not export is a binding pointing at
 * nothing. It is also what lets `wrangler types` give the binding its typed
 * stub.
 */
export { CanvasRoom } from "#/server/canvas-room";

/**
 * The worker's front door, in front of TanStack Start's own handler.
 *
 * Canvas sockets have to be picked off first: Start has no WebSocket path, so
 * an upgrade request that reaches it comes back as HTML and the connection
 * dies opaquely. `routePartykitRequest` claims only `/parties/:party/:room` —
 * where `:party` is the kebab-cased binding name, `canvas-room` — and returns
 * null for everything else, which then flows to Start untouched.
 *
 * The room name in the URL is the project id, and the gate in front of it is
 * the same one every project read enforces: a valid session whose owner is a
 * member of the project's organization. The check runs here, before the
 * Durable Object is ever woken, and the socket rides the page's own session
 * cookie — there is no second token to mint, expire or leak.
 */
export default {
  async fetch(request, env) {
    const routed = await routePartykitRequest(request, env, {
      onBeforeConnect: async (connectRequest, lobby) => {
        const allowed = await canAccessProjectCanvas(connectRequest.headers, lobby.name);

        if (!allowed) return new Response("Unauthorized", { status: 401 });
      },
      // The rooms speak WebSocket only; a plain request to one has taken a
      // wrong turn and should not wake anything up.
      onBeforeRequest: () => new Response("Not found", { status: 404 })
    });

    return routed ?? handler.fetch(request);
  }
} satisfies ExportedHandler<Env>;
