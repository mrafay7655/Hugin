import { describe, expect, it } from "vitest";
import { classifyComment, mergeClassification } from "../src/comments/classify";

type Expect = Partial<ReturnType<typeof classifyComment>>;
const cases: [string, Expect][] = [
  // clear sentiment
  ["Loving the new metal card from @ravenwood ✨", { sentiment: "positive", topic: "card", intent: "praise", needsReply: false, riskFlag: false }],
  ["Ravenwood's customer service actually called me back within 10 minutes. Impressed.", { sentiment: "positive", topic: "service", needsReply: false }],
  ["Great app, super fast and easy to use. Thanks!", { sentiment: "positive", intent: "praise" }],
  ["Worst bank ever. Charged me three overdraft fees this week, absolutely ridiculous.", { sentiment: "negative", topic: "fees", intent: "complaint", needsReply: true, emotion: "anger" }],
  ["The app is down again and I can't pay rent. Fix this", { sentiment: "negative", topic: "outage", intent: "complaint", needsReply: true }],
  ["Switching banks if this happens one more time", { sentiment: "negative", needsReply: true }],
  // negation flips polarity
  ["The app is not good anymore", { sentiment: "negative" }],
  ["Not bad at all, thanks", { sentiment: "positive" }],
  // sarcasm is negative, not praise
  ["Love waiting to see my paycheck. Thanks Ravenwood 🙃", { sentiment: "negative", sarcasm: true, needsReply: true }],
  ["Ravenwood app: \"Something went wrong\". Yeah, no kidding.", { sentiment: "negative" }],
  ["Great, the app is down again, thanks a lot", { sentiment: "negative", sarcasm: true }],
  // questions
  ["What's the fee for an international wire?", { intent: "question", topic: "fees", needsReply: true }],
  ["How long does a wire to Nigeria take?", { intent: "question", needsReply: true }],
  ["Does anyone else get double-charged for a wire?", { intent: "question", needsReply: true }],
  // mixed
  ["Love the card design but the fees are terrible", { sentiment: "mixed", topic: "fees" }],
  // neutral
  ["Regional banks race to add AI fraud protection as text scams surge", { sentiment: "neutral" }],
  ["ok", { sentiment: "neutral", needsReply: false }],
  // scams and spam (the dangerous ones)
  ["You've won a $500 giveaway! Claim now at ravenw00d-rewards.com", { intent: "scam_or_spam", riskFlag: true, needsReply: false }],
  ["DM me for a guaranteed crypto investment opportunity, limited offer", { intent: "scam_or_spam", riskFlag: true }],
  ["Verify your account at ravenwoodbank-secure.net now or lose access", { intent: "scam_or_spam", riskFlag: true }],
  // fraud reports from real customers
  ["Got a text 'from Ravenwood' saying my account is locked with a link. Fake right?", { intent: "fraud_report", riskFlag: true, needsReply: true, emotion: "fear" }],
  ["Someone called pretending to be you and asked for my OTP", { intent: "fraud_report", riskFlag: true, needsReply: true }],
  // legal / regulatory / abuse
  ["I will report you to the CFPB and get a lawyer if this isn't fixed", { riskFlag: true, needsReply: true, sentiment: "negative" }],
  ["This is bullshit, you idiots stole my money. WTF", { riskFlag: true, sentiment: "negative" }],
];

describe("classifyComment()", () => {
  it.each(cases)("%s", (text, expected) => {
    const c = classifyComment(text);
    for (const [k, v] of Object.entries(expected)) expect(c[k as keyof typeof c], `${k} for: ${text}`).toEqual(v);
  });

  it("scores stay within -1..1 and sign matches sentiment", () => {
    for (const [text] of cases) {
      const c = classifyComment(text);
      expect(c.score).toBeGreaterThanOrEqual(-1);
      expect(c.score).toBeLessThanOrEqual(1);
      if (c.sentiment === "positive") expect(c.score).toBeGreaterThan(0);
      if (c.sentiment === "negative") expect(c.score).toBeLessThan(0);
    }
  });

  it("a link to the official domain is not flagged", () => {
    const c = classifyComment("Rates are listed at ravenwoodbank.com/rates, thanks for the quick answer");
    expect(c.intent).not.toBe("scam_or_spam");
    expect(c.riskFlag).toBe(false);
  });

  it("never marks pure praise as needing a reply", () => {
    expect(classifyComment("Best bank ever, love it").needsReply).toBe(false);
  });
});

describe("mergeClassification(): risk is never downgraded", () => {
  const base = classifyComment("Great app, thanks");
  it("keeps a scam flag from the rules even if the model missed it", () => {
    const rules = classifyComment("You've won a giveaway! Claim now at ravenw00d-rewards.com");
    const model = { ...base, source: "gemini" as const };
    const m = mergeClassification(model, rules);
    expect(m.riskFlag).toBe(true);
    expect(m.intent).toBe("scam_or_spam");
    expect(m.source).toBe("gemini");
  });
  it("takes the higher toxicity", () => {
    const m = mergeClassification({ ...base, toxicity: 0.1 }, { ...base, toxicity: 0.8 });
    expect(m.toxicity).toBe(0.8);
  });
});

import { parseMetaComments } from "../src/comments/meta";
import { composeCommentReply } from "../src/comments/replies";
import { checkOutbound } from "../src/policy/guards";

describe("parseMetaComments()", () => {
  it("parses an Instagram comment webhook", () => {
    const [c] = parseMetaComments({ object: "instagram", entry: [{ id: "IG1", changes: [{ field: "comments", value: { id: "17900001", text: "Love it!", from: { id: "55", username: "sana.styles" }, media: { id: "17855555" } } }] }] }, 1000);
    expect(c).toMatchObject({ platform: "instagram", externalId: "17900001", postId: "17855555", author: "@sana.styles", text: "Love it!", at: 1000 });
  });
  it("parses a Facebook Page comment, using Meta's created_time", () => {
    const [c] = parseMetaComments({ object: "page", entry: [{ id: "P1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "123_456", message: "Fees are unfair", post_id: "123_999", from: { id: "9", name: "Greg H." }, created_time: 1760000000 } }] }] });
    expect(c).toMatchObject({ platform: "facebook", externalId: "123_456", postId: "123_999", author: "Greg H.", text: "Fees are unfair", at: 1760000000000 });
  });
  it("ignores edits, deletes, reactions and non-comment feed items", () => {
    const edit = { object: "page", entry: [{ changes: [{ field: "feed", value: { item: "comment", verb: "edited", comment_id: "1", message: "x" } }, { field: "feed", value: { item: "reaction", verb: "add" } }] }] };
    expect(parseMetaComments(edit)).toEqual([]);
  });
  it.each([null, undefined, "x", {}, { object: "instagram" }, { object: "instagram", entry: [{ changes: [{ field: "comments", value: {} }] }] }])("returns nothing for garbage %#", (input) => {
    expect(parseMetaComments(input)).toEqual([]);
  });
});

describe("drafted public replies", () => {
  const draftFor = (text: string, retrieval: Parameters<typeof composeCommentReply>[0]["retrieval"] = null) =>
    composeCommentReply({ classification: classifyComment(text), retrieval, officialDomain: "ravenwoodbank.com", author: "@sam" });

  it("never drafts a reply to scam or spam, so it cannot be engaged with by accident", () => {
    expect(draftFor("You've won a giveaway! Claim now at ravenw00d-rewards.com")).toBeNull();
  });
  it("moves complaints and fraud reports to a private message", () => {
    for (const t of ["The app is down again and I can't pay rent", "Someone called pretending to be you and asked for my OTP", "Overdraft fees are ridiculous"]) {
      expect(draftFor(t)!.text.toLowerCase()).toMatch(/message us|private/);
    }
  });
  it("answers a question only from an approved source, and cites it", () => {
    const r = draftFor("What's the fee for an international wire?", { doc: "Fee Schedule", section: "§4.2", text: "Outgoing international wires are $45 each.", score: 0.95 })!;
    expect(r.text).toContain("$45");
    expect(r.cite).toEqual({ doc: "Fee Schedule", section: "§4.2" });
  });
  it("does not invent an answer when there is no source", () => {
    const r = draftFor("What's the fee for an international wire?", null)!;
    expect(r.text).not.toMatch(/\$\d/);
    expect(r.text.toLowerCase()).toContain("message us privately");
  });
  it("every drafted reply passes the output guard", () => {
    const texts = ["Loving the new card", "The app is down", "Overdraft fees are terrible", "Someone called asking for my PIN", "How long does a wire take?", "ok"];
    for (const t of texts) {
      const d = draftFor(t);
      if (d) expect(checkOutbound(d.text).ok, d.text).toBe(true);
    }
  });
  it("the guard also blocks asking for an SSN or account number in public", () => {
    for (const bad of ["Please send me your account number", "Reply with your SSN", "Share your social security number so we can check"]) {
      expect(checkOutbound(bad).ok, bad).toBe(false);
    }
    expect(checkOutbound("We never ask for your account number or SSN.").ok).toBe(true);
  });
});

describe("fraud reports need a report, not just the word", () => {
  it.each([
    "Honest comparison. Ravenwood wins on fraud protection, Harborline on fees.",
    "Love the new scam alerts, great feature",
    "Regional banks race to add AI fraud protection as text scams surge",
  ])("not a fraud report: %s", (t) => {
    const c = classifyComment(t);
    expect(c.intent).not.toBe("fraud_report");
    expect(c.riskFlag).toBe(false);
  });
  it.each([
    "I was scammed through a fake text pretending to be you",
    "This is a scam, I got a text with a link saying my account is locked",
    "Someone called pretending to be Ravenwood and asked for my OTP",
    "Fraudulent charges on my card overnight",
  ])("a fraud report: %s", (t) => expect(classifyComment(t).intent).toBe("fraud_report"));
});
