import type { Decision, Retrieval, Understanding } from "../types";

export interface ReplyContext {
  firstName: string;
  officialDomain: string;
  decision: Decision;
  understanding: Understanding;
  retrieval: Retrieval | null;
  /** Domains flagged as lookalikes in this message. */
  lookalikes: string[];
}

export interface Reply {
  text: string;
  buttons?: string[];
  cite?: { doc: string; section: string };
  /** A draft a human can approve, when the decision is "draft". */
  approvalDraft?: string;
  approvalReason?: string;
}

/**
 * Replies come from reviewed templates or from approved knowledge text, never from free
 * model generation, so every message the agent can send is known and testable.
 */
export function composeReply(c: ReplyContext): Reply | null {
  const { decision: d, understanding: u, retrieval: r, firstName, officialDomain } = c;
  if (d.action === "none") return null;

  // An unconfirmed fraud signal: reassure, ask for detail, and let a person decide. Nothing is locked.
  if (d.policyId === "P-05") {
    return {
      text: "Thanks for letting us know. I've asked a colleague to look at this right away. Please don't share any codes or PINs with anyone in the meantime.",
      approvalDraft: `Hi ${firstName}, thanks for flagging this. Could you tell me more about what happened? I'm looking into it now.`,
      approvalReason: "Possible fraud signal",
    };
  }

  switch (u.intent) {
    case "otp_scam_report":
      return {
        text: "You did the right thing. We never ask for one-time codes. I've locked your card for safety, and our Fraud team will contact you within 10 minutes.",
        cite: { doc: "Fraud Playbook", section: "§2.1" },
      };
    case "phishing_compromised":
      return {
        text: `Thank you for telling us, ${firstName}. I've locked your card and online access for safety. A Fraud specialist will call you within 10 minutes to help reset everything.`,
      };
    case "fraud_report":
      return {
        text: `I'm sorry this happened, ${firstName}. I've locked your card and opened a priority case. A Fraud specialist will contact you within 10 minutes.`,
      };
    case "phishing_safe":
      return {
        text: `Great, you're safe. Just delete the message. We'll only ever contact you from ${officialDomain}, and we never send links asking you to log in.`,
        cite: { doc: "Fraud Playbook", section: "§3.1" },
      };
    case "phishing_check": {
      const bad = c.lookalikes[0];
      const head = bad
        ? `This is a phishing message. "${bad}" isn't ours.`
        : "I can't confirm this message is from us, so treat it as suspicious.";
      return {
        text: `${head} Our only website is ${officialDomain}. Please don't tap the link. Your account is not locked.\n\nDid you enter any details on that site?`,
        buttons: ["No, I didn't", "Yes, I did"],
        cite: { doc: "Fraud Playbook", section: "§3.1" },
      };
    }
    case "account_change":
      return {
        text: "I can help with that. For your security, a colleague will verify your identity and call you within 15 minutes.",
        approvalDraft: `Hi ${firstName}, this is a colleague from Ravenwood. Before I update your details, I'll call you on the number we have on file to verify your identity.`,
        approvalReason: "Account change",
      };
    case "refund":
    case "complaint":
      return {
        text: "I'm sorry about this. I've passed it to a colleague who can review your account and fees, and they'll reply shortly.",
        approvalDraft: `Hi ${firstName}, I'm really sorry about the fees. I've reviewed your account and I'd like to look at what we can do. Would you like me to turn on low-balance alerts too?`,
        approvalReason: "Refund request",
      };
    case "card_lost":
      return {
        text: "I've locked your card so nobody can use it. A replacement ships in 3 to 5 business days, and you can unlock it in the app if you find it.",
        cite: { doc: "Cards", section: "§1.4" },
      };
    case "balance":
      return {
        text: "For your security I can't share balances in chat. You can see it instantly in the Ravenwood app, or I can have a colleague call you after verifying your identity.",
      };
    case "greeting":
      return {
        text: `Hi ${firstName}! I'm Ravenwood's assistant. I can help with fees, cards, transfers, or anything that looks like a scam. What can I do for you?`,
      };
    case "fx_rate":
      return {
        text: `I don't have today's live rate, so I won't guess. You can see it at ${officialDomain}/rates, or I can connect you with a colleague.`,
      };
    default:
  }

  // Knowledge answers and fallbacks
  if (d.action === "fallback") {
    return {
      text: "I want to get this right, so I've asked a colleague to help. They'll reply here shortly.",
      approvalDraft: `Hi ${firstName}, thanks for your patience. `,
      approvalReason: "No approved source",
    };
  }
  if (r && d.action === "auto_send") return { text: r.text, cite: { doc: r.doc, section: r.section } };
  if (r && d.action === "draft") {
    return { text: "Thanks for your question. A colleague is checking the details and will confirm shortly.", approvalDraft: r.text, approvalReason: "Below confidence threshold", cite: { doc: r.doc, section: r.section } };
  }
  return null;
}
