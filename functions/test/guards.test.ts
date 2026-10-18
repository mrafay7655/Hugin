import { describe, expect, it } from "vitest";
import { checkOutbound, normalizeForGuard } from "../src/policy/guards";
import { composeReply } from "../src/agent/replies";
import { composeCommentReply } from "../src/comments/replies";
import { classifyComment } from "../src/comments/classify";

const OFFICIAL = ["ravenwoodbank.com"];

// Every one of these must be refused. The first block is what slipped through the old guard.
const MUST_BLOCK = [
  "What is your PIN?",
  "Could you tell us the 6-digit code we just texted you?",
  "Please reply with the code you received",
  "Whats your OTP",
  "whats ur pin",
  "WHAT IS YOUR PASSWORD",
  "pls share ur otp",
  "Kindly share the verification code",
  "send ur pin",
  "Send your P I N",
  "Send your ＰＩＮ",
  "Please provide your full card details",
  "What are the last 4 digits and expiry of your card?",
  "Please share your OTP with me",
  "Send me your PIN so I can verify you",
  "Can you provide the one-time code we texted?",
  "Reply with your card number",
  "Enter your password to continue",
  "I need your CVV to proceed",
  "Please confirm your social security number",
  "Share your SSN so we can check",
  "Tell me your account number",
  "Could I have your routing number?",
  "Text me the security code",
  "Type your passcode below",
  "Read out the code that was sent to your phone",
  "Give me your online banking credentials",
  "Please send your 0TP",
  "send me your p1n",
  "What is your mother's maiden name?",
  "I'll need your security answer",
  "Please provide your login code",
  "Forward the authentication code you got",
  "Not sure, but please send your OTP",
  "Never mind that, share your PIN",
  "Please enter the 4-digit code from your SMS",
  "Reply with your two-factor code",
  "Can you confirm your card expiry date and CVV?",
  "Your refund has been processed",
  "You will get your money back today",
  "We are refunding the fee now",
  "We will refund the fee today",
  "I'll reimburse you right away",
  "Your reimbursement is approved",
  "You'll receive your funds back by Friday",
  "We guarantee a refund",
  "We'll reverse the charge",
];

// Every one of these is a normal, safe message and must go out.
const MUST_ALLOW = [
  "We never ask for one-time codes.",
  "Please don't share your OTP with anyone.",
  "Do not share your PIN or password, even with us.",
  "Never give your password to anyone who calls.",
  "We will never ask you to share your PIN, password or one-time code.",
  "Ravenwood will never ask for your account number or SSN.",
  "You did the right thing. I've locked your card.",
  "A colleague will review whether a refund is possible.",
  "International wires cost $45.",
  "We cannot guarantee a refund, but a colleague will look at it.",
  "I can't promise a refund.",
  "No one at Ravenwood will ask for your PIN.",
  "Keep your PIN secret.",
  "Your card ends in 4242 and is now locked.",
  "A one-time fee of $25 applies to expedited delivery.",
  "Use the promo code SAVE10 at checkout.",
  "Activate a card in the app: Cards, then Activate. It takes about a minute.",
  "Branches are open 9am to 5pm Monday to Friday.",
  "I want to get this right, so I've asked a colleague to help.",
  "A colleague will verify your identity and call you within 15 minutes.",
  "Hi James, I'm sorry about the repeated overdraft fees. Would you like low-balance alerts?",
  "Our only website is ravenwoodbank.com. Please don't tap the link.",
  "Thanks for your patience, I'll call you now.",
  "Fraud will contact you within 10 minutes.",
  "We're sorry this wasn't the experience you expected.",
  "Please message us privately and a colleague can look into it.",
  "Don't worry, your account is not locked.",
  "In my opinion the best option is a courtesy call.",
  "We'll check whether the pin on the map is correct.",
  "Your statement is ready in the app.",
  "I never mind a follow-up question.",
  "Delete the message and don't click the link.",
  "The overdraft fee is $30 and a colleague can review it.",
  "Wire transfers usually arrive in 1 to 3 business days.",
  "You can lock or unlock your card in the app at any time.",
  "Never share your one-time code. Ravenwood will not ask for it.",
  "We don't need your PIN for this.",
  "No refund decision has been made yet.",
  "We cannot refund automatically; a colleague decides.",
  "That is a scam. Please ignore it.",
];

describe("normalizeForGuard()", () => {
  it("undoes the usual disguises", () => {
    expect(normalizeForGuard("Send your P I N")).toContain("pin");
    expect(normalizeForGuard("ＰＩＮ")).toBe("pin");
    expect(normalizeForGuard("p1n and 0tp")).toBe("pin and otp");
    expect(normalizeForGuard("ur code")).toBe("your code");
    expect(normalizeForGuard("o.t.p")).toBe("otp");
  });
  it("leaves plain numbers and money alone", () => {
    expect(normalizeForGuard("$45 on 2026-10-15")).toBe("$45 on 2026-10-15");
  });
});

describe("checkOutbound(): requests for secrets and refund promises", () => {
  it.each(MUST_BLOCK)("blocks: %s", (t) => expect(checkOutbound(t).ok, t).toBe(false));
  it.each(MUST_ALLOW)("allows: %s", (t) => expect(checkOutbound(t).ok, t).toBe(true));
  it("a person may promise a refund they are entitled to give, but still cannot ask for a PIN", () => {
    expect(checkOutbound("I'll refund the fee as a courtesy.", { allowRefundLanguage: true }).ok).toBe(true);
    expect(checkOutbound("I'll refund you. Now send your PIN.", { allowRefundLanguage: true }).ok).toBe(false);
  });
  it("the zero-width trick does not hide a request", () => {
    expect(checkOutbound("Send your P​IN").ok).toBe(false);
  });
});

describe("checkOutbound(): links", () => {
  const agent = { officialDomains: OFFICIAL, linkPolicy: "official-only" as const };
  const person = { officialDomains: OFFICIAL, linkPolicy: "no-lookalikes" as const };
  it("allows the official site and its subdomains", () => {
    expect(checkOutbound("Rates are at ravenwoodbank.com/rates", agent).ok).toBe(true);
    expect(checkOutbound("Sign in at https://secure.ravenwoodbank.com/login", agent).ok).toBe(true);
  });
  it.each(["ravenw00d-verify.com", "ravenwoodbank.co", "ravenwood-bank.com", "ravenwoodbank.com.evil.net"])("blocks the lookalike %s for everyone", (d) => {
    expect(checkOutbound(`Please log in at ${d} to confirm`, agent).ok).toBe(false);
    expect(checkOutbound(`Please log in at ${d} to confirm`, person).ok).toBe(false);
  });
  it("the agent may not link anywhere else, but a person may link to a public authority", () => {
    expect(checkOutbound("See consumerfinance.gov for your rights", agent).ok).toBe(false);
    expect(checkOutbound("See consumerfinance.gov for your rights", person).ok).toBe(true);
  });
  it("ordinary text with dots is not mistaken for a link", () => {
    expect(checkOutbound("Open 9 a.m. to 5 p.m., e.g. Monday. Total is 4.5% i.e. low.", agent).ok).toBe(true);
  });
  it("skips link checking when no official domains are known", () => {
    expect(checkOutbound("see example.com").ok).toBe(true);
  });
});

describe("every message HUGIN can write passes its own guard", () => {
  const decision = { action: "auto_send" as const, policyId: "P-01", reason: "", holdingReply: false, requiresHuman: false };
  const intents = ["otp_scam_report", "phishing_compromised", "fraud_report", "phishing_safe", "phishing_check", "account_change", "refund", "complaint", "card_lost", "balance", "greeting", "fx_rate", "fee_inquiry"] as const;
  it("templates, including the approval drafts", () => {
    for (const intent of intents) {
      const r = composeReply({
        firstName: "Marcus", officialDomain: "ravenwoodbank.com", decision, lookalikes: intent === "phishing_check" ? ["ravenw00d-verify.com"] : [],
        understanding: { intent, confidence: 0.9, sentiment: "neutral", language: "en", urls: [], source: "heuristic" },
        retrieval: { doc: "Fee Schedule", section: "§4.2", text: "Outgoing international wires are $45 each.", score: 0.95 },
      });
      if (!r) continue;
      // The phishing reply names the bad domain on purpose, so only the secret and refund rules apply to it.
      expect(checkOutbound(r.text, { officialDomains: intent === "phishing_check" ? undefined : OFFICIAL }).ok, `${intent}: ${r.text}`).toBe(true);
      if (r.approvalDraft) expect(checkOutbound(r.approvalDraft, { officialDomains: OFFICIAL, linkPolicy: "no-lookalikes" }).ok, `${intent} draft`).toBe(true);
    }
  });
  it("drafted public comment replies", () => {
    for (const t of ["Loving the card", "The app is down", "Overdraft fees are terrible", "Someone called asking for my PIN", "How long does a wire take?"]) {
      const d = composeCommentReply({ classification: classifyComment(t), retrieval: null, officialDomain: "ravenwoodbank.com", author: "@sam" });
      if (d) expect(checkOutbound(d.text, { officialDomains: OFFICIAL }).ok, d.text).toBe(true);
    }
  });
});
