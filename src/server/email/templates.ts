/**
 * The two messages this app sends.
 *
 * Light, not dark, unlike everything else in this project. An email is rendered
 * by somebody else's client, most of which assume a light background and a good
 * few of which invert dark markup on their own — a dark template is the one
 * that ends up unreadable somewhere. Styles are inline for the same reason:
 * `<style>` blocks are stripped by several major clients, external stylesheets
 * by all of them.
 *
 * No images, no logo, no tracking pixel. A short transactional message that
 * renders identically with images blocked is worth more than a branded one that
 * arrives as a grey box.
 */

const WRAPPER_STYLE = [
  "margin:0 auto",
  "max-width:480px",
  "padding:32px 24px",
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  "font-size:15px",
  "line-height:1.55",
  "color:#1a1a1a"
].join(";");

const BUTTON_STYLE = [
  "display:inline-block",
  "background:#111111",
  "color:#ffffff",
  "text-decoration:none",
  "padding:11px 20px",
  "border-radius:8px",
  "font-size:14px",
  "font-weight:600"
].join(";");

const MUTED_STYLE = "color:#6b7280;font-size:13px;line-height:1.5";

const HEADING_STYLE = "margin:0 0 16px;font-size:19px;font-weight:600;color:#111111";

/**
 * The link is repeated as text under the button on purpose. A client that
 * refuses to render the anchor, a forwarded copy pasted as plain text, a
 * corporate gateway that rewrites href attributes — in all three the visible
 * URL is the only thing left to act on.
 */
function shell(heading: string, body: string, action: { label: string; url: string }) {
  return `<div style="${WRAPPER_STYLE}">
  <h1 style="${HEADING_STYLE}">${heading}</h1>
  ${body}
  <p style="margin:24px 0"><a href="${action.url}" style="${BUTTON_STYLE}">${action.label}</a></p>
  <p style="${MUTED_STYLE}">Or paste this into your browser:<br /><span style="word-break:break-all">${action.url}</span></p>
</div>`;
}

/**
 * Escaped because both of these interpolate values somebody else chose — an
 * organization's name and the inviter's display name. Neither is markup, and
 * neither should be able to become markup in a mailbox.
 */
function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface InvitationEmailInput {
  organizationName: string;
  /** Who sent it — the fact a recipient checks before clicking. */
  inviterName: string;
  url: string;
  expiresAt: Date;
}

function formatExpiry(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC"
  }).format(date);
}

export function invitationEmail(input: InvitationEmailInput) {
  const organization = escapeHtml(input.organizationName);
  const inviter = escapeHtml(input.inviterName);
  const expiry = formatExpiry(input.expiresAt);

  return {
    // The organization is in the subject because that is what tells someone
    // whether they were expecting this before they open it.
    subject: `${inviter} invited you to ${input.organizationName} on Producer`,
    html: shell(
      `Join ${organization}`,
      `<p style="margin:0">${inviter} has invited you to collaborate in <strong>${organization}</strong> on Producer.</p>
  <p style="${MUTED_STYLE};margin:12px 0 0">This invitation expires on ${expiry}, and only works for the address it was sent to.</p>`,
      { label: "Accept invitation", url: input.url }
    ),
    text: `${input.inviterName} has invited you to collaborate in ${input.organizationName} on Producer.

Accept the invitation:
${input.url}

This invitation expires on ${expiry}, and only works for the address it was sent to. If you were not expecting it, you can ignore this message.`
  };
}

/**
 * Sent from three places now — signing up, signing in without a verified
 * address, and the accept-invitation page — so the wording says what the link
 * does rather than why any one caller wanted it. It used to talk about
 * invitations, which was a confusing thing to read straight after registering.
 */
export function verificationEmail(input: { url: string }) {
  return {
    subject: "Verify your email address",
    html: shell(
      "Verify your email",
      `<p style="margin:0">Confirm this is your address to finish setting up your Producer account.</p>
  <p style="${MUTED_STYLE};margin:12px 0 0">If you did not create an account, you can ignore this message — nothing happens until the link is used.</p>`,
      { label: "Verify email", url: input.url }
    ),
    text: `Confirm this is your address to finish setting up your Producer account.

Verify your email:
${input.url}

If you did not create an account, you can ignore this message — nothing happens until the link is used.`
  };
}

/**
 * The one message here that is worth being careful about: it is the standard
 * shape of a phishing email, so it says plainly that ignoring it is safe and
 * leaves the password unchanged. No urgency, no "your account is at risk".
 */
export function passwordResetEmail(input: { url: string }) {
  return {
    subject: "Reset your Producer password",
    html: shell(
      "Reset your password",
      `<p style="margin:0">Use the link below to choose a new password.</p>
  <p style="${MUTED_STYLE};margin:12px 0 0">If you did not ask to reset it, you can ignore this message — your current password keeps working and nothing has changed.</p>`,
      { label: "Choose a new password", url: input.url }
    ),
    text: `Use the link below to choose a new password.

${input.url}

If you did not ask to reset it, you can ignore this message — your current password keeps working and nothing has changed.`
  };
}

/**
 * The one-time code, and the only template that puts anything in the subject
 * line besides a description.
 *
 * `123456 is your sign-in code` is the shape Apple and Google use, and it earns
 * its place here for a specific local reason: a new sending domain lands in
 * spam folders, and a folder listing shows subject lines. A code that is
 * readable *without opening the message* survives that; a link does not.
 *
 * The trade is that a lock-screen notification shows it too — which is the
 * accepted trade for sign-in codes generally, and why the code is short-lived
 * and single-use.
 */
export function signInCodeEmail(input: { otp: string }) {
  return {
    subject: `${input.otp} is your Producer sign-in code`,
    html: `<div style="${WRAPPER_STYLE}">
  <h1 style="${HEADING_STYLE}">Your sign-in code</h1>
  <p style="margin:0">Enter this code to finish signing in:</p>
  <p style="margin:24px 0;font-size:30px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(input.otp)}</p>
  <p style="${MUTED_STYLE}">It expires in 10 minutes and can only be used once. If you did not ask to sign in, you can ignore this message.</p>
</div>`,
    text: `Enter this code to finish signing in:

${input.otp}

It expires in 10 minutes and can only be used once. If you did not ask to sign in, you can ignore this message.`
  };
}

/** The same thing as a link, for whoever would rather click than type. */
export function signInLinkEmail(input: { url: string }) {
  return {
    subject: "Your Producer sign-in link",
    html: shell(
      "Sign in to Producer",
      `<p style="margin:0">Following this link signs you in and confirms this is your address.</p>
  <p style="${MUTED_STYLE};margin:12px 0 0">It expires in 10 minutes and can only be used once. If you did not ask to sign in, you can ignore this message.</p>`,
      { label: "Sign in", url: input.url }
    ),
    text: `Following this link signs you in and confirms this is your address.

${input.url}

It expires in 10 minutes and can only be used once. If you did not ask to sign in, you can ignore this message.`
  };
}

/**
 * A notification with no link to click, deliberately.
 *
 * It exists so that a password change somebody did *not* make is visible to
 * them, which is the whole point of the message — and the safe reaction to it
 * is to go to the app themselves, not to follow a URL out of an email. Anything
 * clickable here would be training people to do the opposite.
 */
export function passwordChangedEmail() {
  return {
    subject: "Your Producer password was changed",
    html: `<div style="${WRAPPER_STYLE}">
  <h1 style="${HEADING_STYLE}">Your password was changed</h1>
  <p style="margin:0">The password on your Producer account has just been reset, and any other sessions were signed out.</p>
  <p style="${MUTED_STYLE};margin:12px 0 0">If this was not you, reset your password again from the sign-in page to lock the account back down.</p>
</div>`,
    text: `The password on your Producer account has just been reset, and any other sessions were signed out.

If this was not you, reset your password again from the sign-in page to lock the account back down.`
  };
}
