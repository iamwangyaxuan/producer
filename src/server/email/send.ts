import { env } from "cloudflare:workers";

/**
 * The one way mail leaves this app.
 *
 * Two messages go out, both transactional and both a link somebody is waiting
 * for: an organization invitation, and an address verification. Nothing here is
 * for anything else — Email Service is not a marketing channel, and a bounce
 * from a list send costs the sending domain its reputation for the messages
 * that actually matter.
 */

/**
 * The address, and the domain that constrains it: `withproducer.com` is the
 * zone onboarded onto Email Sending (`wrangler email sending list`), and the
 * service refuses a `from` on any other domain with `E_SENDER_NOT_VERIFIED`. So
 * this is not a piece of copy to swap freely — changing the domain means
 * onboarding it first, with `wrangler email sending enable <domain>`.
 *
 * `noreply` because nothing reads the replies. The invitation names the person
 * who sent it in the body instead, which is the part a recipient actually wants
 * to check before clicking anything.
 */
const SENDER = { email: "noreply@withproducer.com", name: "Producer" } as const;

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  /**
   * Required, not optional. Some clients only render this, and a message with
   * no plain-text alternative scores worse with every spam filter that looks —
   * which for a link somebody is waiting on is the difference between arriving
   * and not.
   */
  text: string;
  /**
   * Where a reply should go, when there is a person for it to go to.
   *
   * The `From` stays `noreply@` — that is the recognizable, stable identity a
   * filter builds reputation against — but an invitation has a real human
   * behind it, and "who is this?" deserves somewhere to be asked. A
   * transactional message that can be answered also reads as more legitimate to
   * the filters themselves. Omitted for mail that nobody sent on purpose, like
   * address verification.
   */
  replyTo?: string;
}

/**
 * Sends one message, and answers whether it went.
 *
 * Failures are reported rather than thrown. Every caller here has already
 * committed the thing the mail is *about* — the invitation row exists, the
 * verification token is stored — so a send that fails must not roll that back
 * or turn a successful action into an error page. What it must do is be
 * visible: the caller logs it, and the members page offers the invitation link
 * for copying so a lost email is never the only way in.
 */
export async function sendEmail(message: OutgoingEmail) {
  try {
    const { messageId } = await env.EMAIL.send({
      to: message.to,
      from: SENDER,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      html: message.html,
      text: message.text
    });

    /**
     * Logged on success too, not just on failure.
     *
     * Handing a message to Email Service is where our knowledge of it stops —
     * everything after is the recipient's provider, and "it never arrived"
     * cannot be told apart from "it was never sent" without a record on this
     * side. `messageId` is the handle the Cloudflare dashboard indexes
     * deliveries by, so this line turns that question into a lookup.
     */
    console.log(`sent "${message.subject}" to ${message.to} (${messageId})`);

    return true;
  } catch (error) {
    // `error.code` is one of Email Service's `E_*` codes; the ones worth
    // recognising at a glance are E_SENDER_NOT_VERIFIED (the domain above is
    // not onboarded on this account) and E_RECIPIENT_SUPPRESSED (this address
    // bounced before and Cloudflare will not try it again).
    console.error(`failed to send "${message.subject}" to ${message.to}`, error);

    return false;
  }
}
