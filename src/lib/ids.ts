import { z } from "zod";

/**
 * The shape every client-supplied row id must pass, shared by the access
 * gates and every server function that takes an id.
 *
 * Lowercase is required, not normalized. Postgres compares uuids
 * case-insensitively, so `ABC…` and `abc…` name the same row — but a project
 * id also becomes a Durable Object room name byte-for-byte, where they name
 * two different rooms. Accepting an uppercased id in one entrance and
 * refusing it in another would let the studio shell load while the canvas
 * socket, generation and upload all answer 401 for the same URL; normalizing
 * instead of refusing would quietly fork the canvas into a second, invisible
 * document. Every id this app mints is lowercase; anything else is a
 * hand-mangled URL and every entrance refuses it identically, before it goes
 * anywhere near a query — a malformed literal compared against a `uuid`
 * column makes Postgres raise instead of returning no rows.
 */
export const canonicalId = z.uuid().refine((id) => id === id.toLowerCase());
