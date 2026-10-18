import { checkDomain, extractDomains } from "../policy/domain";

export type CommentSentiment = "positive" | "neutral" | "negative" | "mixed";
export type CommentTopic = "outage" | "fees" | "card" | "fraud" | "service" | "other";
export type CommentIntent = "praise" | "question" | "complaint" | "scam_or_spam" | "fraud_report" | "other";
export type Emotion = "joy" | "trust" | "anger" | "fear" | "sadness" | "none";

export interface CommentClassification {
  sentiment: CommentSentiment;
  /** -1 (very negative) to +1 (very positive). */
  score: number;
  emotion: Emotion;
  topic: CommentTopic;
  intent: CommentIntent;
  sarcasm: boolean;
  /** 0..1 */
  toxicity: number;
  needsReply: boolean;
  /** Anything a person should look at soon: scams, fraud reports, threats, abuse. */
  riskFlag: boolean;
  riskReason: string;
  language: string;
  urls: string[];
  source: "gemini" | "heuristic";
}

const POSITIVE = ["love", "loved", "loving", "lovely", "impressive", "great", "amazing", "thanks", "thank", "awesome", "fast", "helpful", "impressed", "perfect", "best", "good", "smooth", "excellent", "happy", "easy", "fantastic", "recommend", "brilliant", "quick", "solved", "resolved", "friendly"];
const NEGATIVE = ["terrible", "awful", "worst", "hate", "down", "outage", "broken", "stole", "ripped", "unfair", "useless", "angry", "ridiculous", "switching", "closing", "sucks", "slow", "crash", "crashed", "fail", "failed", "waiting", "disappointed", "frustrated", "unacceptable", "nightmare", "rip-off", "overcharged", "charged", "stuck", "locked", "error", "wrong"];
const PROFANITY = ["damn", "hell", "crap", "bullshit", "shit", "fuck", "wtf", "idiots", "scumbags", "stupid"];
const THREATS = /\b(lawyer|sue|lawsuit|regulator|cfpb|attorney general|report you|class action|close my account|closing my account)\b/i;
const NEGATE = /\b(not|never|no|isn'?t|wasn'?t|don'?t|doesn'?t|didn'?t|can'?t|cannot|won'?t|hardly)\s+(\w+\s+)?$/i;
const SPAM_BAIT = /\b(giveaway|you('ve| have)? won|claim (your|now)|dm (me|us)|click (the )?link|verify (your|now)|free (money|cash|gift)|earn \$|crypto|investment opportunity|whatsapp me|telegram me|limited offer)\b/i;
const FRAUD_REPORT = /\b(scammed|phished|defrauded|fraudulent (charges?|transactions?|activity)|(this|that|it) (is|was|looks like|seems like) (a |an )?(scam|phish\w*|fraud)|(a|an|another) (scam|phishing|fraud) (text|call|email|message|attempt)|fake (text|call|email|site|website|link)|fake,? right|is (this|it) (a )?(scam|fake|real|legit)|got a (text|call|email|message).{0,80}(locked|suspended|verify|link)|someone (called|texted|emailed)|pretending to be|asked (me )?for (my )?(otp|pin|code|password)|account (was )?hacked|unauthorized)\b/i;

const TOPICS: [CommentTopic, RegExp][] = [
  ["fraud", /\b(scam|phish|fraud|fake|otp|hack|stolen|unauthorized|pretending)\b/i],
  ["outage", /\b(down|outage|crash|crashed|not working|can'?t log ?in|login|log in|app (is )?(broken|slow)|error|payday)\b/i],
  ["fees", /\b(fee|fees|charged|charge|overdraft|surcharge|overcharged|atm fee|wire fee|interest)\b/i],
  ["card", /\b(card|metal|debit|credit|contactless|declined|chip|pin)\b/i],
  ["service", /\b(support|customer service|call ?back|agent|representative|on hold|wait time|branch|teller|helpful|rude)\b/i],
];

const words = (t: string) => t.toLowerCase().match(/[a-z'’-]+/g) ?? [];

/** Counts lexicon hits, flipping polarity when a negation sits just before the word. */
function polarity(text: string): { pos: number; neg: number } {
  const lower = text.toLowerCase();
  let pos = 0, neg = 0;
  const scan = (list: string[], isPositive: boolean) => {
    for (const w of list) {
      const re = new RegExp(`\\b${w.replace(/-/g, "\\-")}\\b`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(lower)) !== null) {
        const negated = NEGATE.test(lower.slice(Math.max(0, m.index - 20), m.index));
        if (isPositive !== negated) pos++;
        else neg++;
      }
    }
  };
  scan(POSITIVE, true);
  scan(NEGATIVE, false);
  return { pos, neg };
}

export function classifyComment(text: string, officialDomains: string[] = ["ravenwoodbank.com"]): CommentClassification {
  const t = text.trim();
  const ws = words(t);
  let { pos, neg } = polarity(t);

  const urls = extractDomains(t);
  const badLinks = urls.filter((u) => checkDomain(u, officialDomains).verdict !== "official");
  const lookalike = urls.some((u) => checkDomain(u, officialDomains).verdict === "lookalike");

  // Sarcasm: praise words next to a pain point or an eye-roll emoji ("Love waiting for my paycheck 🙃").
  const painContext = /\b(down|outage|waiting|again|still|payday|crash|broken|hours?)\b/i.test(t);
  const eyeRoll = /🙃|🙄|😒/.test(t) || /\byeah,? (no|right)\b|\bno kidding\b|\bthanks a lot\b|\bsure,? great\b/i.test(t);
  const sarcasm = pos > 0 && (eyeRoll || (painContext && neg > 0) || (painContext && /\b(love|thanks|great)\b/i.test(t) && /\bwaiting\b/i.test(t)));
  if (sarcasm) {
    neg += pos + 1;
    pos = 0;
  } else if (eyeRoll && pos === 0) {
    neg += 1; // an eye-roll with no praise words is still a complaint
  }

  const toxicity = Math.min(1, ws.filter((w) => PROFANITY.includes(w)).length * 0.4 + (/[A-Z]{6,}/.test(t) ? 0.15 : 0) + (/!{3,}/.test(t) ? 0.1 : 0));
  const threat = THREATS.test(t);
  if (threat) neg += 2; // a legal or regulatory threat is a strongly negative signal

  const raw = pos + neg === 0 ? 0 : (pos - neg) / (pos + neg);
  const score = +Math.max(-1, Math.min(1, raw + (toxicity > 0.5 ? -0.2 : 0) + (threat ? -0.2 : 0))).toFixed(2);
  let sentiment: CommentSentiment = score > 0.25 ? "positive" : score < -0.25 ? "negative" : "neutral";
  if (pos > 0 && neg > 0 && Math.abs(score) <= 0.5 && !sarcasm) sentiment = "mixed";

  const topic = TOPICS.find(([, re]) => re.test(t))?.[0] ?? "other";

  const spam = (SPAM_BAIT.test(t) && (badLinks.length > 0 || /\b(dm|whatsapp|telegram)\b/i.test(t))) || (lookalike && !FRAUD_REPORT.test(t));
  const fraudReport = !spam && FRAUD_REPORT.test(t);
  const question = /\?|\b(how (do|can|long)|what('s| is)|when (will|does)|why (is|do|does)|can (you|i)|is there|does anyone)\b/i.test(t);

  // A mildly negative question ("does anyone else get double-charged?") is a question, not a complaint.
  const mildQuestion = question && neg <= 1 && toxicity < 0.3 && !threat;
  const intent: CommentIntent = spam ? "scam_or_spam" : fraudReport ? "fraud_report" : mildQuestion ? "question" : sentiment === "negative" ? "complaint" : question ? "question" : sentiment === "positive" ? "praise" : "other";

  const emotion: Emotion =
    intent === "fraud_report" ? "fear" : sentiment === "negative" ? (toxicity > 0.3 || /\b(angry|furious|ridiculous|unacceptable|worst|hate)\b/i.test(t) ? "anger" : "sadness") : sentiment === "positive" ? (/\b(thank|thanks|trust|safe|secure|helpful)\b/i.test(t) ? "trust" : "joy") : "none";

  const reasons: string[] = [];
  if (spam) reasons.push(lookalike ? `lookalike link ${urls.find((u) => checkDomain(u, officialDomains).verdict === "lookalike")}` : "scam or spam bait");
  if (fraudReport) reasons.push("customer reports fraud");
  if (threat) reasons.push("legal or regulatory threat");
  if (toxicity >= 0.6) reasons.push("abusive language");
  const riskFlag = reasons.length > 0;

  const needsReply = !spam && (intent === "question" || intent === "complaint" || intent === "fraud_report" || threat);

  return { sentiment, score, emotion, topic, intent, sarcasm, toxicity: +toxicity.toFixed(2), needsReply, riskFlag, riskReason: reasons.join("; "), language: "en", urls, source: "heuristic" };
}

/** When the model and the rules disagree, keep the more cautious reading of risk. */
export function mergeClassification(model: CommentClassification, rules: CommentClassification): CommentClassification {
  const riskFlag = model.riskFlag || rules.riskFlag;
  const spamOrFraud = (c: CommentClassification) => c.intent === "scam_or_spam" || c.intent === "fraud_report";
  const intent = spamOrFraud(rules) && !spamOrFraud(model) ? rules.intent : model.intent;
  return {
    ...model,
    intent,
    riskFlag,
    riskReason: [model.riskReason, rules.riskReason].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("; "),
    needsReply: model.needsReply || rules.needsReply,
    toxicity: Math.max(model.toxicity, rules.toxicity),
    urls: Array.from(new Set([...model.urls, ...rules.urls])),
  };
}
