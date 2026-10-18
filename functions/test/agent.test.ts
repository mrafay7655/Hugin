import { describe, expect, it } from "vitest";
import { heuristicUnderstand, mergeUnderstanding, understand } from "../src/agent/understand";
import { retrieveFromDocs, type KbDoc } from "../src/agent/retrieve";
import { composeReply } from "../src/agent/replies";
import { decide } from "../src/policy/engine";
import { checkOutbound } from "../src/policy/guards";
import { answerToOffer } from "../src/agent/run";
import { DEFAULT_POLICY, type Intent, type Understanding } from "../src/types";

const KB: KbDoc[] = [
  { id: "fee", title: "Fee Schedule", status: "active", sections: [
    { id: "§4.2", title: "International wires", text: "Outgoing international wires are $45 each. Wires sent before 4pm ET go out the same business day." },
    { id: "§4.1", title: "Domestic wires", text: "Outgoing domestic wires are $25. Incoming wires are free." },
  ] },
  { id: "xfer", title: "International Transfers", status: "active", sections: [{ id: "§2.1", title: "Delivery times", text: "International wires usually arrive in 1 to 3 business days depending on the receiving bank." }] },
  { id: "cards", title: "Cards", status: "active", sections: [{ id: "§1.1", title: "Activation", text: "Activate a card in the app: Cards then Activate." }] },
  { id: "old", title: "Card Fees FAQ (2024)", status: "retired", sections: [{ id: "§1", title: "Old international wire fee", text: "International wires cost $35." }] },
];

describe("heuristicUnderstand()", () => {
  const cases: [string, Intent][] = [
    ["Someone just called saying they're from the bank and asked for my one-time code", "otp_scam_report"],
    ["A guy called and asked for my PIN", "otp_scam_report"],
    ["Is this text really from you?", "phishing_check"],
    ["I got this link ravenw00d-verify.com is it real", "phishing_check"],
    ["I need to change the phone number on my account", "account_change"],
    ["Charged an overdraft fee AGAIN. I want a refund", "complaint"],
    ["I think I lost my card at the gym", "card_lost"],
    ["And today's exchange rate?", "fx_rate"],
    ["what's my balance", "balance"],
    ["Hello", "greeting"],
    ["What's the fee for an international wire?", "knowledge_question"],
    ["asdf qwerty", "unknown"],
  ];
  it.each(cases)("%s → %s", (text, intent) => {
    expect(heuristicUnderstand({ text, kind: "text" }).intent).toBe(intent);
  });
  it("a button answer only counts when it is passed as one", () => {
    expect(heuristicUnderstand({ text: "Yes, I did", kind: "text", buttonReply: "Yes, I did" }).intent).toBe("phishing_compromised");
    expect(heuristicUnderstand({ text: "No, I didn't", kind: "text", buttonReply: "No, I didn't" }).intent).toBe("phishing_safe");
    // the same words in an ordinary message are not an answer to anything
    for (const t of ["Yes I did pay my bill on time", "No I didnt get my statement", "Yes, I did"]) {
      expect(["phishing_compromised", "phishing_safe"]).not.toContain(heuristicUnderstand({ text: t, kind: "text" }).intent);
    }
  });
  it("a link to the bank's own site is not a phishing check", () => {
    const own = { officialDomains: ["ravenwoodbank.com"] };
    expect(heuristicUnderstand({ text: "Is ravenwoodbank.com/rates the right page for rates?", kind: "text", ...own }).intent).not.toBe("phishing_check");
    expect(heuristicUnderstand({ text: "is ravenw00d-verify.com real", kind: "text", ...own }).intent).toBe("phishing_check");
  });
  it("treats a forwarded screenshot as a phishing check", () => {
    const r = heuristicUnderstand({ text: "Is this real?", kind: "image", imageText: "Your account is LOCKED. Verify at ravenw00d-verify.com" });
    expect(r.intent).toBe("phishing_check");
    expect(r.urls).toContain("ravenw00d-verify.com");
  });
});

describe("mergeUnderstanding(): the safety net can only make things more cautious", () => {
  const model = (intent: Intent, confidence = 0.99): Understanding => ({ intent, confidence, sentiment: "neutral", language: "en", urls: [], source: "gemini" });
  const rules = (intent: Intent): Understanding => ({ intent, confidence: 0.94, sentiment: "anxious", language: "en", urls: [], source: "heuristic" });

  it("a model that downgrades a fraud report to a greeting is overridden", () => {
    expect(mergeUnderstanding(model("greeting"), rules("otp_scam_report")).intent).toBe("otp_scam_report");
  });
  it("a model that says fraud when rules say routine keeps fraud", () => {
    expect(mergeUnderstanding(model("fraud_report"), rules("knowledge_question")).intent).toBe("fraud_report");
  });
  it("agreeing readings keep the model's output", () => {
    const m = mergeUnderstanding(model("fee_inquiry"), rules("knowledge_question"));
    expect(m.intent).toBe("fee_inquiry");
    expect(m.source).toBe("gemini");
  });
});

describe("retrieveFromDocs()", () => {
  it("finds the international wire fee with a high score", () => {
    const r = retrieveFromDocs("What's the fee for an international wire?", KB)!;
    expect(r.section).toBe("§4.2");
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });
  it("prefers the Fee Schedule over a delivery-times doc for a fee question (title match)", () => {
    expect(retrieveFromDocs("What's the fee for an international wire?", KB)!.doc).toBe("Fee Schedule");
    expect(retrieveFromDocs("How long does an international wire take to arrive?", KB)!.doc).toBe("International Transfers");
  });
  it("never cites a retired document", () => {
    const r = retrieveFromDocs("international wire fee", KB)!;
    expect(r.doc).not.toMatch(/2024/);
    expect(r.text).not.toMatch(/\$35/);
  });
  it("returns nothing useful for an unsupported question", () => {
    const r = retrieveFromDocs("And today's exchange rate?", KB);
    expect(r === null || r.score < DEFAULT_POLICY.draft).toBe(true);
  });
  it("returns null for an empty query", () => expect(retrieveFromDocs("the and for", KB)).toBeNull());
});

describe("every reply the agent can send passes the output guard", () => {
  const intents: Intent[] = [
    "otp_scam_report", "phishing_compromised", "fraud_report", "phishing_safe", "phishing_check", "account_change", "refund", "complaint",
    "card_lost", "balance", "greeting", "fx_rate", "fee_inquiry", "knowledge_question", "unknown",
  ];
  it.each(intents)("%s", (intent) => {
    const u: Understanding = { intent, confidence: 0.9, sentiment: "neutral", language: "en", urls: [], source: "heuristic" };
    const retrieval = retrieveFromDocs("international wire fee", KB);
    for (const r of [retrieval, null]) {
      const decision = decide({ understanding: u, retrieval: r, policy: DEFAULT_POLICY, mode: "agent" });
      const reply = composeReply({ firstName: "Sam", officialDomain: "ravenwoodbank.com", decision, understanding: u, retrieval: r, lookalikes: ["ravenw00d-verify.com"] });
      if (!reply) continue;
      expect(checkOutbound(reply.text).ok, `reply for ${intent}: ${reply.text}`).toBe(true);
      if (reply.approvalDraft) expect(checkOutbound(reply.approvalDraft).ok).toBe(true);
    }
  });
});

describe("understand(): keeps the model and rule readings apart for the Agent Console", () => {
  const input = { text: "Someone called and asked for my one-time code", kind: "text" as const };
  const modelRun = async () => ({
    understanding: { intent: "greeting" as const, confidence: 0.99, sentiment: "neutral", language: "en", urls: [], source: "gemini" as const },
    toolCalls: [{ name: "check_domain", args: { domain: "example.com" }, result: { verdict: "unrelated" } }],
  });

  it("returns the raw model reading, the rule reading, and the merged intent", async () => {
    const r = await understand(modelRun, input);
    expect(r.modelReading?.intent).toBe("greeting");
    expect(r.rulesReading.intent).toBe("otp_scam_report");
    expect(r.understanding.intent).toBe("otp_scam_report");
    expect(r.toolCalls.map((t) => t.name)).toEqual(["check_domain"]);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
  it("without a model there is no model reading and no error", async () => {
    const r = await understand(null, input);
    expect(r.modelReading).toBeUndefined();
    expect(r.modelError).toBeUndefined();
    expect(r.understanding.intent).toBe("otp_scam_report");
  });
  it("a model failure falls back to rules and reports the error", async () => {
    const r = await understand(async () => { throw new Error("adk timeout"); }, input);
    expect(r.modelError).toBe("adk timeout");
    expect(r.modelReading).toBeUndefined();
    expect(r.understanding.intent).toBe("otp_scam_report");
  });
});

describe("fraud keywords: strong evidence locks, a mere mention does not", () => {
  const strong = [
    "Someone just called saying they're from the bank and asked for my one-time code",
    "A guy called and asked for my PIN",
    "They texted me and wanted my verification code",
    "The caller asked me to read out the code they sent",
    "I gave them my OTP and now I'm worried",
    "Someone pretending to be Ravenwood asked for my password",
  ];
  const weak = [
    "Someone called me about my PIN",
    "A caller mentioned my password",
  ];
  const routine = [
    "I forgot my PIN, can someone call me?",
    "Can I change my password by text?",
    "Someone said there is a promo code for the metal card",
    "In my opinion someone should call me back",
    "What is the zip code for your HQ?",
    "Yes I did pay my bill on time",
    "How do I reset my online banking password?",
    "My pin on the map is wrong",
    "I want my statement sent by text",
  ];
  it.each(strong)("strong: %s", (t) => {
    const r = heuristicUnderstand({ text: t, kind: "text" });
    expect(r.intent).toBe("otp_scam_report");
    expect(r.evidence).toBe("strong");
  });
  it.each(weak)("weak: %s", (t) => {
    const r = heuristicUnderstand({ text: t, kind: "text" });
    expect(r.intent).toBe("otp_scam_report");
    expect(r.evidence).toBe("weak");
  });
  it.each(routine)("not fraud: %s", (t) => {
    const r = heuristicUnderstand({ text: t, kind: "text" });
    expect(["otp_scam_report", "phishing_compromised", "fraud_report"], `${t} → ${r.intent}`).not.toContain(r.intent);
  });
});

describe("mergeUnderstanding(): unconfirmed fraud goes to a person, never straight to a card lock", () => {
  const model = (intent: Intent, confidence = 0.95): Understanding => ({ intent, confidence, sentiment: "neutral", language: "en", urls: [], source: "gemini" });
  const rules = (intent: Intent, evidence?: "strong" | "weak"): Understanding => ({ intent, confidence: evidence === "weak" ? 0.7 : 0.94, sentiment: "anxious", language: "en", urls: [], source: "heuristic", ...(evidence ? { evidence } : {}) });

  it("strong rules beat a model that says greeting", () => {
    const m = mergeUnderstanding(model("greeting"), rules("otp_scam_report", "strong"));
    expect([m.intent, m.evidence]).toEqual(["otp_scam_report", "strong"]);
  });
  it("weak rules that the model does not confirm stay weak", () => {
    const m = mergeUnderstanding(model("unknown"), rules("otp_scam_report", "weak"));
    expect([m.intent, m.evidence]).toEqual(["otp_scam_report", "weak"]);
  });
  it("weak rules confirmed by the model become strong", () => {
    const m = mergeUnderstanding(model("otp_scam_report"), rules("otp_scam_report", "weak"));
    expect(m.evidence).toBe("strong");
  });
  it("a model that is sure about fraud on its own is trusted; an unsure one is not", () => {
    expect(mergeUnderstanding(model("fraud_report", 0.95), rules("unknown")).evidence).toBe("strong");
    expect(mergeUnderstanding(model("fraud_report", 0.6), rules("unknown")).evidence).toBe("weak");
  });
});

describe("decide(): P-05 and P-07", () => {
  const u = (evidence?: "strong" | "weak"): Understanding => ({ intent: "otp_scam_report", confidence: 0.9, sentiment: "anxious", language: "en", urls: [], source: "heuristic", ...(evidence ? { evidence } : {}) });
  it("weak evidence drafts for a person (P-05) and does not lock", () => {
    const d = decide({ understanding: u("weak"), retrieval: null, policy: DEFAULT_POLICY, mode: "agent" });
    expect([d.action, d.policyId, d.holdingReply, d.requiresHuman]).toEqual(["draft", "P-05", true, true]);
  });
  it("strong or unmarked evidence still locks at once (P-07)", () => {
    for (const e of [undefined, "strong" as const]) {
      expect(decide({ understanding: u(e), retrieval: null, policy: DEFAULT_POLICY, mode: "agent" }).action).toBe("safety_and_escalate");
    }
  });
  it("the P-05 reply reassures, drafts a follow-up, and passes the guard", () => {
    const decision = decide({ understanding: u("weak"), retrieval: null, policy: DEFAULT_POLICY, mode: "agent" });
    const r = composeReply({ firstName: "Sam", officialDomain: "ravenwoodbank.com", decision, understanding: u("weak"), retrieval: null, lookalikes: [] })!;
    expect(r.approvalReason).toBe("Possible fraud signal");
    expect(checkOutbound(r.text).ok).toBe(true);
    expect(checkOutbound(r.approvalDraft!).ok).toBe(true);
  });
});

describe("answerToOffer()", () => {
  const offered = ["No, I didn't", "Yes, I did"];
  it("counts a tap, and a short typed yes or no, but only when buttons were offered", () => {
    expect(answerToOffer(offered, { text: "Yes, I did", viaButton: true })).toBe("Yes, I did");
    expect(answerToOffer(offered, { text: "yes" })).toBe("yes");
    expect(answerToOffer([], { text: "Yes, I did", viaButton: true })).toBeUndefined();
    expect(answerToOffer([], { text: "yes" })).toBeUndefined();
  });
  it("a long message that starts with yes is not an answer", () => {
    expect(answerToOffer(offered, { text: "Yes I did pay my bill on time, thanks" })).toBeUndefined();
  });
  it("a tap on a button we did not offer is ignored", () => {
    expect(answerToOffer(offered, { text: "Delete my account", viaButton: true })).toBeUndefined();
  });
});
