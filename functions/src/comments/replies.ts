import type { Retrieval } from "../types";
import type { CommentClassification } from "./classify";

export interface CommentReply {
  text: string;
  cite?: { doc: string; section: string };
}

/**
 * Suggested PUBLIC replies. Rules for anything posted in public:
 *  - never ask for or confirm personal or account details (move to a private message instead)
 *  - never promise a refund or a fix date
 *  - answer questions only from approved knowledge, with its source
 * A person reviews every reply before it is posted.
 */
export function composeCommentReply(c: { classification: CommentClassification; retrieval: Retrieval | null; officialDomain: string; author: string }): CommentReply | null {
  const { classification: k, retrieval, officialDomain } = c;
  const handle = c.author.startsWith("@") ? c.author : "";
  const hi = handle ? `${handle} ` : "";

  if (k.intent === "scam_or_spam") return null; // do not engage; hide or report instead

  if (k.intent === "fraud_report") {
    return { text: `${hi}Thank you for flagging this. We never ask for one-time codes or passwords, and our only website is ${officialDomain}. Please don't tap the link. Message us privately and our Fraud team will help right away.` };
  }
  if (k.intent === "complaint") {
    if (k.topic === "outage") return { text: `${hi}We're sorry about the trouble. Our team is working on it and your money is safe. Please message us privately if you need help with a payment today.` };
    if (k.topic === "fees") return { text: `${hi}We're sorry about the frustration. We'd like to look at your account and the fees. Please send us a private message so a colleague can help.` };
    return { text: `${hi}We're sorry this wasn't the experience you expected. Please message us privately so a colleague can look into it.` };
  }
  if (k.intent === "question") {
    if (retrieval && retrieval.score >= 0.85) return { text: `${hi}${retrieval.text}`, cite: { doc: retrieval.doc, section: retrieval.section } };
    return { text: `${hi}Good question. Message us privately and a colleague will confirm the details for you.` };
  }
  if (k.intent === "praise") return { text: `${hi}Thank you, that means a lot to the whole team.` };
  return null;
}
