import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "cloudflare:workers";

import { getDB, schema } from "#/db";

import {
  activateForNewUser,
  CREATABLE_TYPES,
  DEFAULT_SEATS,
  ensurePrivateOrganization,
  ensurePrivateOrganizationById,
  hasFreeSeat,
  isCreatableType
} from "./organization";

/** The type a `/organization/create` call gets when it does not ask for one. */
const DEFAULT_CREATED_TYPE = "team";

/**
 * Refuses a join that would put the organization over what it pays for. Reads
 * the ceiling off the row better-auth already loaded, so this costs one count
 * rather than a count and a lookup.
 */
async function assertFreeSeat(organization: { id: string; seat?: unknown }) {
  const seat = typeof organization.seat === "number" ? organization.seat : 0;

  if (await hasFreeSeat(organization.id, seat)) return;

  throw new APIError("FORBIDDEN", {
    message: `This organization has no seats left (${seat} in total).`
  });
}

const db = getDB();

export const auth = betterAuth({
  experimental: { joins: true },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // `*.localhost` resolves to the loopback interface in every browser, so a
  // second origin on the same dev server is how two accounts can be signed in
  // side by side (cookie jars are per-origin). Trusting it only widens the
  // origin check for pages that already run on this machine; no request from
  // the outside world can carry this Origin header.
  trustedOrigins: ["http://app.localhost:3000"],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    transaction: true
  }),
  advanced: {
    database: {
      generateId: false
    }
  },
  emailAndPassword: {
    enabled: true
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET
    }
  },
  databaseHooks: {
    user: {
      create: {
        // Every new user — whether they signed up with Google, email/password
        // or SSO — gets their own private organization.
        after: async (user, ctx) => {
          if (!ctx) return;

          const privateOrganization = await ensurePrivateOrganization(ctx.context.adapter, user);

          await activateForNewUser(ctx.context.adapter, user.id, privateOrganization.id);
        }
      }
    },
    session: {
      create: {
        // A fresh session starts without an active organization; fall back to
        // the user's private one so the app always has an organization scope.
        before: async (session, ctx) => {
          if (!ctx || session.activeOrganizationId) return;

          const privateOrganization = await ensurePrivateOrganizationById(
            ctx.context.adapter,
            session.userId
          );
          if (!privateOrganization) return;

          return { data: { ...session, activeOrganizationId: privateOrganization.id } };
        }
      }
    }
  },
  plugins: [
    organization({
      // These are what make the columns visible to better-auth at all: the
      // adapter builds every insert by walking the declared fields, so an
      // undeclared column is silently dropped from the write rather than
      // rejected — and `owner_id` / `type` are NOT NULL.
      schema: {
        organization: {
          additionalFields: {
            // `input: false` keeps the field out of the request body schema, so
            // there is no shape of `POST /organization/create` that lets a
            // caller name someone else as owner. It is filled in below, from
            // the session.
            ownerId: { type: "string", required: true, input: false },
            // Accepted from the client, but only as a request — the hook below
            // is what decides the value that reaches the database. `required`
            // here is about the request body, not the column: it is what makes
            // `type` optional to send, so a caller that does not care gets the
            // default rather than a 400. The column stays NOT NULL because the
            // hook always fills it.
            type: { type: "string", required: false, input: true },
            seat: { type: "number", required: false, input: false }
          }
        }
      },
      organizationHooks: {
        beforeCreateOrganization: async ({ organization, user }) => {
          const requested = organization.type ?? DEFAULT_CREATED_TYPE;

          // `private` is the sign up hook's to create and a user gets exactly
          // one, which the partial unique index enforces. Refusing it here is
          // what turns that into a message the client can act on instead of a
          // constraint violation surfacing as a 500.
          if (!isCreatableType(requested)) {
            throw new APIError("BAD_REQUEST", {
              message: `Organization type must be one of: ${CREATABLE_TYPES.join(", ")}.`
            });
          }

          return {
            data: {
              ...organization,
              ownerId: user.id,
              type: requested,
              seat: DEFAULT_SEATS[requested]
            }
          };
        },
        // The two ways someone becomes a member, and so the two places the paid
        // ceiling has to hold. `beforeAddMember` also runs for the creator's own
        // membership at `/organization/create`, where the organization is empty
        // and a seat is always free.
        //
        // Neither covers the paths that write `member` directly — SSO
        // provisioning and SCIM both bypass these hooks entirely — so an
        // identity provider can still push an organization past its allowance.
        // That is a gap in enforcement, not in the record: the count is
        // recoverable from `member` whenever billing needs to reconcile it.
        beforeAddMember: async ({ organization }) => {
          await assertFreeSeat(organization);
        },
        beforeAcceptInvitation: async ({ organization }) => {
          await assertFreeSeat(organization);
        }
      }
    }),
    sso({
      // Users signing in through an organization's SSO provider join that
      // organization automatically.
      organizationProvisioning: { defaultRole: "member" }
    }),
    scim({
      storeSCIMToken: "hashed"
    }),
    // Keep last: it writes the cookies produced by every other plugin.
    tanstackStartCookies()
  ]
});
