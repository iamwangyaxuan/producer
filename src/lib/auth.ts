import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "cloudflare:workers";

import { getDB, schema } from "#/db";

import {
  activateForNewUser,
  ensurePersonalOrganization,
  ensurePersonalOrganizationById
} from "./organization";

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
        // or SSO — gets their own personal organization.
        after: async (user, ctx) => {
          if (!ctx) return;

          const personalOrganization = await ensurePersonalOrganization(ctx.context.adapter, user);

          await activateForNewUser(ctx.context.adapter, user.id, personalOrganization.id);
        }
      }
    },
    session: {
      create: {
        // A fresh session starts without an active organization; fall back to
        // the user's personal one so the app always has an organization scope.
        before: async (session, ctx) => {
          if (!ctx || session.activeOrganizationId) return;

          const personalOrganization = await ensurePersonalOrganizationById(
            ctx.context.adapter,
            session.userId
          );
          if (!personalOrganization) return;

          return { data: { ...session, activeOrganizationId: personalOrganization.id } };
        }
      }
    }
  },
  plugins: [
    organization({
      schema: {
        organization: {
          additionalFields: {
            // Set by the sign up hook only, never by the client.
            personalOwnerId: { type: "string", required: false, input: false }
          }
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
