import { createGateway } from "ai";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { getDB, schema } from "#/db";

/**
 * An organization's own AI Gateway key: sealing it, checking it, and getting it
 * back out.
 *
 * The key is a live credential for somebody else's Vercel account. Three rules
 * follow from that, and they are the whole of this module:
 *
 * - **It is encrypted before it reaches the database.** A dump, a backup, or a
 *   query captured in a log should not be enough to spend their money.
 * - **It never travels back to a browser.** Nothing here returns the plaintext
 *   to a caller that could serialize it; the settings page is given four
 *   characters and a timestamp. A key that can be read back is a key that will
 *   eventually be read back by the wrong person.
 * - **It is proved before it is stored.** An unverified key turns every
 *   generation in the organization into a failure whose cause is nowhere on
 *   screen, which is a far worse outcome than a rejected form.
 */

/** Nonce length AES-GCM is specified for; 96 bits is the only size to use. */
const IV_BYTES = 12;

/** How much of the key the settings page may show. Enough to recognise. */
const PREVIEW_CHARS = 4;

/**
 * The encryption key, derived from the app's own secret.
 *
 * HKDF with a fixed `info` string rather than using `BETTER_AUTH_SECRET`
 * directly: the same secret already signs sessions and webhooks, and one
 * derivation per purpose is what keeps a weakness in one from being a weakness
 * in the others.
 *
 * The consequence is worth stating plainly, because it is the kind that is
 * discovered at the worst moment: **rotating `BETTER_AUTH_SECRET` makes every
 * stored key undecryptable.** Nothing is lost that cannot be pasted in again —
 * these are credentials their owners still hold — but the failure looks like
 * "generations suddenly stopped", so the recovery is to remove and re-enter the
 * key, and the fix if that is ever unacceptable is a dedicated secret with its
 * own rotation story.
 *
 * Cached per isolate: the derivation is the same work every time and depends on
 * nothing but the environment.
 */
let derived: Promise<CryptoKey> | null = null;

function encryptionKey() {
  derived ??= (async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.BETTER_AUTH_SECRET),
      "HKDF",
      false,
      ["deriveKey"]
    );

    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        // Empty salt, fixed info. The salt buys nothing here — the input is a
        // single high-entropy secret rather than a password, and there is
        // exactly one derivation — while `info` is what separates this use of
        // the secret from every other one.
        salt: new Uint8Array(0),
        info: new TextEncoder().encode("producer:organization-gateway-key:v1")
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  })();

  return derived;
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function seal(plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    new TextEncoder().encode(plaintext)
  );

  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

async function open(ciphertext: string, iv: string) {
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    await encryptionKey(),
    fromBase64(ciphertext)
  );

  return new TextDecoder().decode(opened);
}

export class GatewayKeyError extends Error {}

/**
 * Whether the Gateway accepts this key, asked before anything is stored.
 *
 * `getCredits` because it is the cheapest authenticated call the SDK offers —
 * it reads a balance, generates nothing, and costs the key's owner nothing.
 *
 * The error is deliberately not passed through. Whatever the Gateway says comes
 * back through a client holding the key, and the one thing that must never be
 * echoed to a screen or a log is the credential itself; "rejected" is also the
 * only thing the person can act on.
 */
async function verifyKey(apiKey: string) {
  try {
    await createGateway({ apiKey }).getCredits();
  } catch {
    throw new GatewayKeyError(
      "The AI Gateway did not accept that key. Check it was copied whole, and that it is still active."
    );
  }
}

/** What a key looks like from outside — never the key itself. */
export interface GatewayKeyStatus {
  /** The last few characters, so somebody can tell which key is installed. */
  preview: string;
  verifiedAt: Date;
  updatedAt: Date;
}

/**
 * Verifies a key and installs it as this organization's, replacing any
 * previous one.
 *
 * Verification comes first and the write only happens if it passed, so a
 * failed attempt leaves the organization on whatever it was using before
 * rather than in a state where nothing works.
 */
export async function saveGatewayKey(
  organizationId: string,
  userId: string,
  apiKey: string
): Promise<GatewayKeyStatus> {
  const trimmed = apiKey.trim();

  if (trimmed.length < 8) throw new GatewayKeyError("That does not look like a key.");

  await verifyKey(trimmed);

  const { ciphertext, iv } = await seal(trimmed);
  const preview = trimmed.slice(-PREVIEW_CHARS);
  const verifiedAt = new Date();

  const [row] = await getDB()
    .insert(schema.organizationGatewayKey)
    .values({ organizationId, ciphertext, iv, preview, createdBy: userId, verifiedAt })
    .onConflictDoUpdate({
      target: schema.organizationGatewayKey.organizationId,
      set: { ciphertext, iv, preview, createdBy: userId, verifiedAt, updatedAt: new Date() }
    })
    .returning({
      preview: schema.organizationGatewayKey.preview,
      verifiedAt: schema.organizationGatewayKey.verifiedAt,
      updatedAt: schema.organizationGatewayKey.updatedAt
    });

  // The plaintext is dropped here and never cached: the next call that needs it
  // decrypts its own copy, which keeps the window it exists in as short as the
  // work that uses it.
  return row;
}

/** Back to the system key. Answers whether there was anything to remove. */
export async function removeGatewayKey(organizationId: string) {
  const removed = await getDB()
    .delete(schema.organizationGatewayKey)
    .where(eq(schema.organizationGatewayKey.organizationId, organizationId))
    .returning({ organizationId: schema.organizationGatewayKey.organizationId });

  return removed.length > 0;
}

/**
 * What the settings page is allowed to know: which key, and since when.
 *
 * Deliberately does not decrypt. Every screen that asks "is a key installed"
 * asks far more often than any screen that needs to *use* one, and answering
 * from the preview column keeps the plaintext out of all of them.
 */
export async function readGatewayKeyStatus(
  organizationId: string
): Promise<GatewayKeyStatus | null> {
  const [row] = await getDB()
    .select({
      preview: schema.organizationGatewayKey.preview,
      verifiedAt: schema.organizationGatewayKey.verifiedAt,
      updatedAt: schema.organizationGatewayKey.updatedAt
    })
    .from(schema.organizationGatewayKey)
    .where(eq(schema.organizationGatewayKey.organizationId, organizationId))
    .limit(1);

  return row ?? null;
}

/**
 * The organization's key in the clear, for the one caller that has to make a
 * request with it. `null` when it has none.
 *
 * Server-only by construction — it lives in `server/` and the value it returns
 * is handed straight to `createGateway`. Nothing in this app puts the result on
 * a response.
 */
export async function readGatewayKey(organizationId: string): Promise<string | null> {
  const [row] = await getDB()
    .select({
      ciphertext: schema.organizationGatewayKey.ciphertext,
      iv: schema.organizationGatewayKey.iv
    })
    .from(schema.organizationGatewayKey)
    .where(eq(schema.organizationGatewayKey.organizationId, organizationId))
    .limit(1);

  if (!row) return null;

  try {
    return await open(row.ciphertext, row.iv);
  } catch (error) {
    // Almost always one thing: `BETTER_AUTH_SECRET` has changed since this row
    // was written, so the derived key no longer opens it. Logged loudly and
    // answered as "no key", which falls the organization back to the system
    // key rather than failing every generation — and the settings page still
    // shows a key is installed, which is the prompt to re-enter it.
    console.error(`could not decrypt the gateway key for organization ${organizationId}`, error);

    return null;
  }
}
