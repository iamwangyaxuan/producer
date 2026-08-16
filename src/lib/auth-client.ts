import { scimClient } from "@better-auth/scim/client";
import { ssoClient } from "@better-auth/sso/client";
import { stripeClient } from "@better-auth/stripe/client";
import { emailOTPClient, magicLinkClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    // The two passwordless doors: `signIn.emailOtp` / `emailOtp.sendVerificationOtp`
    // and `signIn.magicLink`. Both double as email verification — see `auth.ts`.
    emailOTPClient(),
    magicLinkClient(),
    organizationClient(),
    ssoClient(),
    scimClient(),
    // `subscription: true` is what adds `authClient.subscription.*`; without it
    // the plugin only contributes error codes. `upgrade` is the call that turns
    // a reserved organization id into a checkout — see `lib/billing.ts`.
    stripeClient({ subscription: true })
  ]
});
