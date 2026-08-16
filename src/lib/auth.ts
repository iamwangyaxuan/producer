import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { stripe as stripePlugin } from "@better-auth/stripe";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { emailOTP, magicLink, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { env } from "cloudflare:workers";

import { getDB, schema } from "#/db";
import { SEAT_PLANS } from "#/lib/plans";
import { stripe as stripeClient, stripeWebhookSecret } from "#/server/billing/stripe-client";
import { handleStripeEvent } from "#/server/billing/stripe-events";
import { sendEmail } from "#/server/email/send";
import {
  passwordChangedEmail,
  passwordResetEmail,
  signInCodeEmail,
  signInLinkEmail,
  verificationEmail
} from "#/server/email/templates";

import {
  activateForNewUser,
  applyPurchasedOrganization,
  authorizeOrganizationBilling,
  CREATABLE_TYPES,
  DEFAULT_SEATS,
  ensurePrivateOrganization,
  ensurePrivateOrganizationById,
  hasFreeSeat,
  isCreatableType,
  nameFromEmail
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
    enabled: true,
    /**
     * An address has to be proved before it can be signed in with.
     *
     * Google accounts arrive already verified, so this only governs the
     * email/password path — and there it closes a real hole: nothing stops
     * somebody registering `ceo@target.com` without reading that mailbox, and
     * an unverified account is one that can be handed an organization
     * invitation meant for the real owner of the address.
     *
     * Turning this on also hardens sign up itself, which is worth knowing:
     * better-auth switches to a generic response for an address that already
     * exists, so the form can no longer be used to find out who has an account.
     */
    requireEmailVerification: true,
    /**
     * A password reset is what somebody does when they think the old one is
     * compromised, so every other session goes with it. The cost is being
     * signed out on your other devices; the alternative is leaving whoever
     * prompted the reset still signed in.
     */
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      const sent = await sendEmail({ to: user.email, ...passwordResetEmail({ url }) });

      // The endpoint answers "if this email exists, check your inbox" either
      // way — deliberately, so it cannot be used to enumerate accounts — which
      // means a failure here is invisible to the person waiting for the link.
      if (!sent) console.error(`password reset email for ${user.id} did not send`);
    },
    /**
     * The account has just changed hands as far as the old password is
     * concerned, and the person who owns the address deserves to hear about it
     * whether or not they were the one who did it. Carries no link — see the
     * template for why.
     */
    onPasswordReset: async ({ user }) => {
      await sendEmail({ to: user.email, ...passwordChangedEmail() });
    }
  },
  emailVerification: {
    /**
     * Both entry points send it. `sendOnSignUp` is what makes registration
     * complete on its own; `sendOnSignIn` is what rescues the account that
     * never got the first one — without it, an unverified user would be
     * refused at sign in with no way to ask for another link.
     */
    sendOnSignUp: true,
    sendOnSignIn: true,
    /**
     * The link is proof of both things at once — that the address is theirs,
     * and that they are the one holding it — so making them type the password
     * again immediately afterwards adds a step without adding a check.
     */
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const sent = await sendEmail({ to: user.email, ...verificationEmail({ url }) });

      if (!sent) console.error(`verification email for ${user.id} did not send`);
    }
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
        /**
         * Nobody gets a blank name.
         *
         * No form here asks for one: sign up takes an address and a password,
         * and the passwordless doors take a code or a link. Left alone,
         * better-auth writes `name: ""` and every screen downstream falls back
         * to printing the raw address. `nameFromEmail` is what a person would
         * have typed anyway — it makes the private organization read as
         * `1234's Organization` instead of `1234@xxx.com's Organization`.
         *
         * Only fills a blank: Google and SSO supply a real name, and a guess
         * derived from an address should never overwrite one.
         */
        before: async (user) => {
          if (user.name.trim()) return;

          const derived = nameFromEmail(user.email).trim();
          if (!derived) return;

          return { data: { ...user, name: derived } };
        },
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
    /**
     * The two passwordless ways in, and the reason `requireEmailVerification`
     * above is livable.
     *
     * Both of them *are* the verification. Receiving a code or a link and
     * coming back with it proves the same thing a verification email proves —
     * that this person reads this mailbox — so better-auth writes
     * `emailVerified: true` on the way through: a brand new address is created
     * already verified, and an existing unverified account is upgraded (after
     * `revokeUnprovenAccountAccess` kills whatever sessions it had, in case
     * somebody else registered the address first and never proved it).
     *
     * That turns "verify your email" from a chore into a side effect of signing
     * in, and it gives an account locked out by the verification requirement a
     * way to rescue itself without a support ticket.
     *
     * `overrideDefaultEmailVerification` is deliberately left off: password
     * sign-up keeps its own verification *link*, and these two are additional
     * doors rather than a replacement for that one.
     */
    emailOTP({
      otpLength: 6,
      // Long enough to go and find the mail — which on a cold sending domain
      // may mean digging it out of a spam folder — and short enough that a code
      // read off a lock screen is stale by the time anyone acts on it.
      expiresIn: 600,
      // After three wrong tries the code is burned rather than left to be
      // guessed; a fresh one is one button away.
      allowedAttempts: 3,
      sendVerificationOTP: async ({ email, otp }) => {
        const sent = await sendEmail({ to: email, ...signInCodeEmail({ otp }) });

        if (!sent) console.error(`sign-in code for ${email} did not send`);
      }
    }),
    magicLink({
      expiresIn: 600,
      sendMagicLink: async ({ email, url }) => {
        const sent = await sendEmail({ to: email, ...signInLinkEmail({ url }) });

        if (!sent) console.error(`sign-in link for ${email} did not send`);
      }
    }),
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
        // Reached only by a direct call to `/organization/create`. The product
        // path does not come through here at all: an organization is bought
        // before it exists, so it is written by `applyPurchasedOrganization`
        // once the subscription completes — with the seat count that was paid
        // for, and with the id the subscription already names. This hook is
        // what keeps better-auth's own endpoint producing a valid row anyway,
        // on the free default rather than a purchased number.
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
    /**
     * Seats are sold here, and an organization is what a purchase produces.
     *
     * After `organization`, because the plugin reaches for that one during
     * `init` — it only rewires its hooks when `organization.enabled` is set,
     * which this does not, but ordering it correctly costs nothing and makes
     * enabling that later a one-line change rather than a debugging session.
     *
     * `organization.enabled` stays off because of the order this app buys in.
     * That option makes the *organization* the Stripe customer, which requires
     * the organization to exist when checkout starts; here it does not exist
     * yet, so the customer is the person paying — which is also simply true.
     * What the subscription is *for* is carried by `referenceId` instead, and
     * that is the id the organization is later created with.
     */
    stripePlugin({
      stripeClient,
      stripeWebhookSecret,
      /**
       * Everything the plugin does not sell, on the same endpoint it already
       * verifies signatures for.
       *
       * Credit top-ups are one-time payments, which this plugin has no concept
       * of — it only ever creates `mode: "subscription"` sessions. Rather than
       * a second webhook route with a second secret to configure, they settle
       * here: `onEvent` runs for every event, and the one they settle on
       * (`payment_intent.succeeded`) is one the plugin passes straight through
       * without trying to read a subscription out of it.
       *
       * Anything thrown here becomes a non-200 and therefore a Stripe retry —
       * see `handleStripeEvent` for why that is the right way to fail.
       */
      onEvent: handleStripeEvent,
      // Signing up should not depend on a billing system being reachable, and
      // most accounts never buy anything. The customer is created on the first
      // checkout instead, which the plugin's upgrade path already does.
      createCustomerOnSignUp: false,
      subscription: {
        enabled: true,
        // The catalogue, narrowed to what the plugin needs. `name` doubles as
        // the organization type the plan creates — see `plans.ts`.
        plans: SEAT_PLANS.map((plan) => ({
          name: plan.name,
          priceId: plan.priceId,
          limits: { seats: plan.maxSeats }
        })),
        // No `requireEmailVerification`: this app sends no verification mail,
        // so turning it on would make every email/password account unable to
        // buy anything, with nothing they could do about it.
        //
        // Every subscription action names a reference id, and this is the only
        // thing standing between a caller and somebody else's billing. It is
        // reached for organizations that exist and for ones that are still just
        // a paid-for intention; `authorizeOrganizationBilling` knows both.
        authorizeReference: async ({ user, referenceId }) =>
          authorizeOrganizationBilling(user.id, referenceId),
        /**
         * The checkout completed, so the organization it bought can exist.
         *
         * This runs inside the webhook handler, which catches everything it
         * throws and only logs it — so a failure here is invisible from the
         * outside. That is why the checkout page verifies the outcome itself
         * rather than trusting the delivery, and why the work is idempotent:
         * Stripe redelivers, and the retry has to land on the same
         * organization rather than a second one.
         */
        onSubscriptionComplete: async ({ subscription }) => {
          if (!subscription?.referenceId) return;

          await applyPurchasedOrganization({
            referenceId: subscription.referenceId,
            seats: subscription.seats ?? 1
          });
        }
      }
    }),
    // Keep last: it writes the cookies produced by every other plugin.
    tanstackStartCookies()
  ]
});
