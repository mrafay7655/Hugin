import type { Decision, Intent, Policy, Retrieval, Understanding } from "../types";

/** Intents that are always handled as a fraud emergency. */
const FRAUD_INTENTS = new Set<Intent>(["otp_scam_report", "phishing_compromised", "fraud_report"]);
/** Intents that need a human by policy regardless of confidence. */
const HUMAN_BY_POLICY: Partial<Record<Intent, { id: string; why: string }>> = {
  account_change: { id: "P-04", why: "Identity and account changes always need a human" },
  refund: { id: "P-03", why: "Refund decisions always need a human" },
  complaint: { id: "P-03", why: "Complaints with churn risk need a human" },
};
/** Intents that can be answered without a knowledge source. */
const NO_SOURCE_NEEDED = new Set<Intent>(["greeting", "balance", "card_lost", "phishing_check", "phishing_safe", "card_activation"]);

export interface DecideInput {
  understanding: Understanding;
  retrieval: Retrieval | null;
  policy: Policy;
  mode: "agent" | "human";
}

/**
 * The model proposes (intent + confidence); this function decides.
 * Pure and deterministic so every governance claim can be unit-tested.
 */
export function decide({ understanding: u, retrieval, policy, mode }: DecideInput): Decision {
  if (mode === "human") {
    return { action: "none", policyId: "P-00", reason: "A human is in control of this conversation", holdingReply: false, requiresHuman: true };
  }

  // A fraud keyword the rules cannot be sure of, with no confirmation from the model: a person looks first.
  // Nothing is locked on a hunch; a clear request for a code, or both readings agreeing, still locks at once.
  if (FRAUD_INTENTS.has(u.intent) && u.evidence === "weak") {
    return { action: "draft", policyId: "P-05", reason: "Possible fraud signal, not confirmed: a person reviews it before any card is locked", holdingReply: true, requiresHuman: true };
  }

  if (FRAUD_INTENTS.has(u.intent)) {
    return { action: "safety_and_escalate", policyId: "P-07", reason: "Fraud always needs a human", holdingReply: true, requiresHuman: true };
  }

  if (u.intent === "phishing_check") {
    return { action: "auto_send", policyId: "P-08", reason: "Phishing check: warn first, then ask whether details were entered", holdingReply: false, requiresHuman: false };
  }

  const byPolicy = HUMAN_BY_POLICY[u.intent];
  if (byPolicy || policy.alwaysHuman.includes(u.intent)) {
    const p = byPolicy ?? { id: "P-04", why: `${u.intent} is configured as always-human` };
    return { action: "draft", policyId: p.id, reason: p.why, holdingReply: u.intent !== "complaint", requiresHuman: true };
  }

  if (NO_SOURCE_NEEDED.has(u.intent)) {
    return { action: "auto_send", policyId: "P-01", reason: "Low-risk intent, no source required", holdingReply: false, requiresHuman: false };
  }

  const threshold = policy.perIntent[u.intent] ?? policy.autoSend;
  const sourceScore = retrieval?.score ?? 0;
  // The reply is only as trustworthy as the weaker of understanding and source.
  const confidence = Math.min(u.confidence, retrieval ? sourceScore : 0);

  if (!retrieval || sourceScore < policy.draft) {
    return { action: "fallback", policyId: "P-02", reason: "No approved source above the minimum score. Never guess", holdingReply: true, requiresHuman: true };
  }
  if (confidence >= threshold) {
    return { action: "auto_send", policyId: "P-01", reason: `Confidence ${confidence.toFixed(2)} >= ${threshold.toFixed(2)}`, holdingReply: false, requiresHuman: false };
  }
  if (confidence >= policy.draft) {
    return { action: "draft", policyId: "P-06", reason: `Confidence ${confidence.toFixed(2)} below ${threshold.toFixed(2)}: draft for approval`, holdingReply: false, requiresHuman: true };
  }
  return { action: "fallback", policyId: "P-02", reason: "Confidence too low. Never guess", holdingReply: true, requiresHuman: true };
}

/** The effective confidence shown in the UI for a decision. */
export function effectiveConfidence(u: Understanding, r: Retrieval | null): number {
  return r ? Math.min(u.confidence, r.score) : u.confidence;
}
