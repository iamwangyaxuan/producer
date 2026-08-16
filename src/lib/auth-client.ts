import { scimClient } from "@better-auth/scim/client";
import { ssoClient } from "@better-auth/sso/client";
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
    scimClient()
  ]
});
