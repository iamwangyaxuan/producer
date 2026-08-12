import type { Edge } from "@xyflow/react";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { GenerationNodeData } from "#/components/block/studio/generation-node";
import { edgesMap, nodeDataMap, nodesMap } from "#/lib/canvas/doc";
import type { StoredNode } from "#/lib/canvas/doc";
import type { PresenceState, PresenceUser } from "#/lib/canvas/presence";

/**
 * The party segment of the socket URL. partyserver routes
 * `/parties/:party/:room` to the Durable Object binding whose kebab-cased name
 * matches `:party` — so this string is the binding `CanvasRoom` in
 * `wrangler.jsonc`, spelled the way the router spells it.
 */
const CANVAS_PARTY = "canvas-room";

export interface CanvasSession {
  doc: Y.Doc;
  provider: YProvider;
  awareness: Awareness;
  nodes: Y.Map<StoredNode>;
  nodeData: Y.Map<GenerationNodeData>;
  edges: Y.Map<Edge>;
  /** Identifies this tab in awareness states — how a cursor knows it is not its own. */
  clientId: number;
  /**
   * The origin every local transaction is tagged with, so the document
   * observers can tell a write this tab just made from one that arrived over
   * the wire and only re-render for the latter.
   */
  localOrigin: object;
  destroy: () => void;
}

/**
 * One live connection to a project's shared canvas: the Yjs document, the
 * WebSocket provider syncing it, and the awareness instance carrying presence.
 *
 * Browser-only — the provider dials `window.location.host` — and one per
 * mounted canvas: a Y.Doc must never be shared between two provider lifetimes
 * (the yjs FAQ is emphatic that reusing client ids across live documents can
 * corrupt them), so leaving a project destroys the whole session and opening
 * it again builds a fresh one.
 */
export function createCanvasSession(projectId: string, user: PresenceUser): CanvasSession {
  const doc = new Y.Doc();

  // Same origin as the page, so the session cookie rides along with the
  // upgrade request and the server can decide who this is before accepting.
  const provider = new YProvider(window.location.host, projectId, doc, {
    party: CANVAS_PARTY,
    // The page's own scheme decides, not the provider's hostname guesswork:
    // its default only treats `localhost` and private IPs as plain-ws, so any
    // other name for a dev server — `app.localhost`, a tunnel — would be
    // dialled over TLS it does not speak. Secure pages get wss, plain get ws,
    // which is the same answer for every host the app is actually served on.
    protocol: window.location.protocol === "https:" ? "wss" : "ws"
  });

  // Seeded before anything else happens: `setLocalStateField` — which the
  // cursor stream uses — is a silent no-op while the local state is null.
  const state: PresenceState = { user, cursor: null };

  provider.awareness.setLocalState(state);

  return {
    doc,
    provider,
    awareness: provider.awareness,
    nodes: nodesMap(doc),
    nodeData: nodeDataMap(doc),
    edges: edgesMap(doc),
    clientId: doc.clientID,
    localOrigin: {},
    destroy() {
      // Provider first: it announces the departure (clearing this client's
      // awareness state for everyone else) while the document is still alive.
      provider.destroy();
      doc.destroy();

      // The provider's `connect()` defers its real work to a microtask, so a
      // session torn down in the same tick it was created — StrictMode's
      // double-mount, a fast route change — can have a connection attempt
      // still queued that will run *after* this destroy and open a socket
      // nobody owns. A macrotask runs after every queued microtask, which
      // makes it the one place a second disconnect is guaranteed to catch the
      // stray; when nothing was queued it finds nothing to do.
      setTimeout(() => provider.disconnect(), 0);
    }
  };
}
