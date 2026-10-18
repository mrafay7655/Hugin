import { checkDomain, extractDomains } from "../policy/domain";
import type { Intent, MessageKind, Understanding } from "../types";
import type { AdkRun } from "./adk/pipeline";

export interface MediaPart {
  mimeType: string;
  data: Buffer;
}

export interface UnderstandInput {
  text: string;
  kind: MessageKind;
  /** Text visible in a forwarded screenshot, if already known (simulator). Gemini reads it from the image otherwise. */
  imageText?: string;
  media?: MediaPart;
  /** The customer's answer to buttons we offered, e.g. "Yes, I did". Never set for an ordinary message. */
  buttonReply?: string;
  /** The bank's own domains. Links to them are not suspicious. */
  officialDomains?: string[];
}

/** How cautious an intent is. When two readings disagree, the higher rank wins. */
const CAUTION: Partial<Record<Intent, number>> = {
  otp_scam_report: 100, phishing_compromised: 100, fraud_report: 100,
  account_change: 80, refund: 70, complaint: 70,
  phishing_check: 60, card_lost: 50,
};
const rank = (i: Intent) => CAUTION[i] ?? 0;
export const FRAUD_INTENTS = new Set<Intent>(["otp_scam_report", "phishing_compromised", "fraud_report"]);
const isFraud = (i: Intent) => FRAUD_INTENTS.has(i);

// A secret nobody should ever give out. Whole words only: "opinion" is not a PIN.
const SECRET_TERM = String.raw`(?:otp|one[\s-]?time[\s-]?(?:code|pass\w*|pin|token)|(?:verification|security|authentication|login|confirmation|sms|2fa)[\s-]?code|\d[\s-]?digit[\s-]?(?:code|pin)|pin|passcode|password|cvv)s?`;
const CODE_THEY_SENT = String.raw`codes?(?=\s+(?:they|he|she|you|we|that|just|sent|texted|received))`;
/** Somebody asked the customer for a secret. */
const REQUESTED = new RegExp(String.raw`\b(?:ask(?:ed|ing|s)?|request(?:ed|ing|s)?|want(?:ed|s)?|demand(?:ed|ing|s)?|need(?:ed|s)?|told\s+me\s+to|made\s+me|required|tell|give|read|share|send)\b[^.?!\n]{0,45}?\b(?:${SECRET_TERM}|${CODE_THEY_SENT})\b`);
/** The customer says they handed a secret to someone. */
const GAVE = new RegExp(String.raw`\bi\s+(?:gave|shared|told|read(?:\s+out)?|sent)\s+(?:them|him|her|someone|the\s+caller|that\s+person)\b[^.?!\n]{0,30}\b(?:${SECRET_TERM}|code)\b`);
/** Clearly somebody else contacting the customer. */
const OTHER_PARTY = /\b(?:some(?:one|body)\s+(?:just\s+)?(?:called|texted|emailed|messaged|asked|said|claimed|pretended|is\s+asking|wanted|wants)|a\s+(?:guy|man|woman|lady|person|caller|stranger)|the\s+caller|scammer|stranger|pretend\w*|claim\w*|they\s+(?:called|texted|asked|said|wanted|want|claimed)|(?:called|texted|emailed|messaged)\s+me|(?:call|text|email|message)\s+from|from\s+the\s+bank)\b/;
const HAS_SECRET = new RegExp(String.raw`\b(?:${SECRET_TERM}|${CODE_THEY_SENT})\b`);

/** Rule-based reading. Also the fallback when the model is unavailable. */
export function heuristicUnderstand({ text, imageText, buttonReply, officialDomains }: UnderstandInput): Understanding {
  const t = `${text} ${imageText ?? ""}`.toLowerCase();
  const urls = extractDomains(`${text} ${imageText ?? ""}`);
  // A link to our own site is not suspicious. Only others make this a phishing check.
  const foreign = urls.filter((u) => !officialDomains?.length || checkDomain(u, officialDomains).verdict !== "official");
  const base = { language: "en", urls, source: "heuristic" as const };

  // An answer to the "did you enter any details?" buttons. Only counts when we actually offered them.
  if (buttonReply) {
    const b = buttonReply.trim().toLowerCase();
    if (/^yes\b/.test(b)) return { ...base, intent: "phishing_compromised", sentiment: "anxious", confidence: 0.98 };
    if (/^no\b/.test(b)) return { ...base, intent: "phishing_safe", sentiment: "relieved", confidence: 0.95 };
  }

  // Fraud by phone or text. A clear request from someone else is strong evidence; a mention is not.
  if ((REQUESTED.test(t) && OTHER_PARTY.test(t)) || GAVE.test(t)) return { ...base, intent: "otp_scam_report", sentiment: "anxious", confidence: 0.94, evidence: "strong" };
  if (HAS_SECRET.test(t) && OTHER_PARTY.test(t)) return { ...base, intent: "otp_scam_report", sentiment: "anxious", confidence: 0.7, evidence: "weak" };

  if (imageText || foreign.length > 0 || /is this (text|message|email|link) (real|really|from you|legit)/.test(t))
    return { ...base, intent: "phishing_check", sentiment: "worried", confidence: 0.95 };

  if (/(change|update|new).{0,30}(phone|number|address|email|name)/.test(t))
    return { ...base, intent: "account_change", sentiment: "neutral", confidence: 0.95 };

  if (/\b(refund|unfair|ridiculous|close my account|worst|third time|again!)|overdraft.{0,25}(again|third|another|too many|unfair|ridiculous)|charged\s+(?:me\s+)?(?:twice|again|three|3)/.test(t))
    return { ...base, intent: "complaint", sentiment: "angry", confidence: 0.85 };

  if (/(lost|stolen|missing).{0,20}card|card.{0,20}(lost|stolen)/.test(t))
    return { ...base, intent: "card_lost", sentiment: "worried", confidence: 0.92 };

  if (/(exchange rate|fx rate|rate today|today's rate|conversion rate)/.test(t))
    return { ...base, intent: "fx_rate", sentiment: "neutral", confidence: 0.9 };

  if (/(balance|how much (money|do i have))/.test(t)) return { ...base, intent: "balance", sentiment: "neutral", confidence: 0.9 };
  if (/activate/.test(t) && /card/.test(t)) return { ...base, intent: "card_activation", sentiment: "neutral", confidence: 0.9 };
  if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(t.trim()) && t.trim().length < 30)
    return { ...base, intent: "greeting", sentiment: "positive", confidence: 0.99 };
  if (/\b(fee|fees|cost|charge|wire|transfer|limit|rate)\b/.test(t)) return { ...base, intent: "knowledge_question", sentiment: "neutral", confidence: 0.9 };
  return { ...base, intent: "unknown", sentiment: "neutral", confidence: 0.5 };
}

/** A model that names a fraud intent on its own, without being sure, is not enough to lock a card. */
const MODEL_ALONE_SURE = 0.85;

/**
 * Combine the model's reading with the rule-based safety net.
 *  - A strong rule hit can never be downgraded by the model, so a manipulated model cannot hide fraud.
 *  - A weak rule hit that the model does not confirm stays a fraud signal but is marked unconfirmed,
 *    so a person reviews it instead of the card being locked on a keyword.
 *  - Both readings agreeing on fraud is confirmation.
 */
export function mergeUnderstanding(model: Understanding, rules: Understanding): Understanding {
  const urls = Array.from(new Set([...model.urls, ...rules.urls]));
  const rulesFraud = isFraud(rules.intent), modelFraud = isFraud(model.intent);

  if (rulesFraud && rules.evidence === "weak") {
    if (modelFraud) return { ...model, urls, evidence: "strong" };
    return { ...model, intent: rules.intent, sentiment: rules.sentiment, confidence: Math.min(model.confidence, rules.confidence), urls, evidence: "weak" };
  }
  if (rank(rules.intent) > rank(model.intent)) {
    return { ...model, intent: rules.intent, sentiment: rules.sentiment, confidence: Math.min(model.confidence, rules.confidence), urls: model.urls.length ? model.urls : rules.urls, ...(rules.evidence ? { evidence: rules.evidence } : {}) };
  }
  if (modelFraud && !rulesFraud) return { ...model, urls, evidence: model.confidence >= MODEL_ALONE_SURE ? "strong" : "weak" };
  return { ...model, urls };
}

/** Runs the ADK pipeline. Injected so the agent can run without a model (emulators, tests). */
export type AdkUnderstander = (input: UnderstandInput) => Promise<AdkRun>;

export interface UnderstandResult {
  understanding: Understanding;
  /** Read-only tools Gemini chose to call (empty when running on rules only). */
  toolCalls: AdkRun["toolCalls"];
  /** Set when Gemini was tried and failed, so the trace can say so. */
  modelError?: string;
  /** The model's own reading before the safety-net merge. Absent when Gemini was not used. */
  modelReading?: Understanding;
  /** The rule-based reading, always computed. */
  rulesReading: Understanding;
  /** Milliseconds spent understanding the message (the ADK run, when used). */
  ms: number;
  /** Which pipeline ran, when Gemini was used. */
  mode?: "full" | "fast";
}

/**
 * Gemini through ADK when available, always merged with the rule-based safety net.
 * Any model failure degrades to rules, never to silence.
 */
export async function understand(adk: AdkUnderstander | null, input: UnderstandInput): Promise<UnderstandResult> {
  const t0 = Date.now();
  const rules = heuristicUnderstand(input);
  if (!adk) return { understanding: rules, toolCalls: [], rulesReading: rules, ms: Date.now() - t0 };
  try {
    const run = await adk(input);
    return { understanding: mergeUnderstanding(run.understanding, rules), toolCalls: run.toolCalls, modelReading: run.understanding, rulesReading: rules, ms: Date.now() - t0, mode: run.mode };
  } catch (e) {
    return { understanding: rules, toolCalls: [], modelError: (e as Error).message, rulesReading: rules, ms: Date.now() - t0 };
  }
}
