// Domain types shared by the policy engine, the agent and the Firestore layer.
// The web app keeps a mirrored copy in web/src/lib/types.ts.

export type Channel = "whatsapp" | "instagram" | "facebook" | "x" | "tiktok" | "telegram" | "webchat";
export type MessageKind = "text" | "voice" | "image";
export type Transport = "whatsapp" | "telegram" | "sim";

export type Intent =
  | "otp_scam_report"
  | "phishing_check"
  | "phishing_compromised"
  | "phishing_safe"
  | "fraud_report"
  | "card_lost"
  | "account_change"
  | "complaint"
  | "refund"
  | "fee_inquiry"
  | "wire_timing"
  | "fx_rate"
  | "balance"
  | "card_activation"
  | "greeting"
  | "knowledge_question"
  | "unknown";

export type Sentiment = "positive" | "neutral" | "worried" | "anxious" | "angry" | "relieved";

export interface Understanding {
  intent: Intent;
  sentiment: Sentiment;
  language: string;
  /** Model or heuristic confidence in the intent, 0..1. */
  confidence: number;
  /** Plain-text transcript of a voice note, or text read from an image. */
  transcript?: string;
  urls: string[];
  source: "gemini" | "heuristic";
  /**
   * For a fraud reading: "weak" means the signal is not confirmed (a keyword hit the rules cannot be sure of,
   * or a model that is unsure on its own). A weak fraud reading goes to a person; it never locks a card by itself.
   * Absent means strong.
   */
  evidence?: "strong" | "weak";
}

export interface Retrieval {
  doc: string;
  section: string;
  text: string;
  /** Relevance 0..1. Below the draft threshold there is no usable source. */
  score: number;
}

export type Action =
  | "none" //                  agent is silent (human in control)
  | "auto_send" //             send the grounded or templated reply
  | "draft" //                 hold for human approval (optionally send a holding reply)
  | "safety_and_escalate" //   fraud: reply, lock card, open case, notify
  | "fallback"; //             no source: honest fallback + hand to a human

export interface Decision {
  action: Action;
  /** Short policy id shown in the UI and audit log, e.g. "P-07". */
  policyId: string;
  /** Human-readable explanation. */
  reason: string;
  holdingReply: boolean;
  requiresHuman: boolean;
}

export interface Policy {
  autoSend: number;
  draft: number;
  alwaysHuman: string[];
  perIntent: Record<string, number>;
  blocked: string[];
}

export const DEFAULT_POLICY: Policy = {
  autoSend: 0.85,
  draft: 0.6,
  alwaysHuman: ["account_change", "refund", "money_movement", "identity"],
  perIntent: {},
  blocked: ["Ask for a one-time code", "Ask for a PIN or password", "Promise a refund"],
};

export interface TraceStep {
  label: "Understood" | "Retrieved" | "Checked" | "Decided" | "Acted";
  detail: string;
  tone?: "ok" | "warn";
}
