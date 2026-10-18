import { describe, expect, it } from "vitest";
import { decide } from "../src/policy/engine";
import { checkOutbound, windowOpen, WINDOW_MS } from "../src/policy/guards";
import { checkDomain, extractDomains } from "../src/policy/domain";
import { DEFAULT_POLICY, type Intent, type Policy, type Retrieval, type Understanding } from "../src/types";

const u = (intent: Intent, confidence = 0.95): Understanding => ({
  intent, confidence, sentiment: "neutral", language: "en", urls: [], source: "heuristic",
});
const src = (score: number): Retrieval => ({ doc: "Fee Schedule", section: "§4.2", text: "x", score });
const P: Policy = { ...DEFAULT_POLICY };

describe("decide()", () => {
  it("stays silent when a human is in control", () => {
    expect(decide({ understanding: u("fee_inquiry"), retrieval: src(0.95), policy: P, mode: "human" }).action).toBe("none");
  });

  it.each(["otp_scam_report", "phishing_compromised", "fraud_report"] as Intent[])(
    "%s always escalates as fraud (P-07), whatever the confidence",
    (intent) => {
      for (const c of [0.2, 0.99]) {
        const d = decide({ understanding: u(intent, c), retrieval: null, policy: P, mode: "agent" });
        expect(d.action).toBe("safety_and_escalate");
        expect(d.policyId).toBe("P-07");
        expect(d.requiresHuman).toBe(true);
      }
    },
  );

  it("never auto-sends account changes, even at 0.99 confidence with a perfect source", () => {
    const d = decide({ understanding: u("account_change", 0.99), retrieval: src(1), policy: P, mode: "agent" });
    expect(d.action).toBe("draft");
    expect(d.policyId).toBe("P-04");
    expect(d.holdingReply).toBe(true);
  });

  it("never auto-sends refunds or complaints", () => {
    for (const i of ["refund", "complaint"] as Intent[]) {
      const d = decide({ understanding: u(i, 0.99), retrieval: src(1), policy: P, mode: "agent" });
      expect(d.action).toBe("draft");
      expect(d.requiresHuman).toBe(true);
    }
  });

  it("honours a custom always-human intent", () => {
    const pol: Policy = { ...P, alwaysHuman: [...P.alwaysHuman, "fee_inquiry"] };
    expect(decide({ understanding: u("fee_inquiry"), retrieval: src(0.95), policy: pol, mode: "agent" }).action).toBe("draft");
  });

  it("auto-sends a grounded answer at or above the threshold", () => {
    const d = decide({ understanding: u("fee_inquiry", 0.95), retrieval: src(0.93), policy: P, mode: "agent" });
    expect(d.action).toBe("auto_send");
  });

  it("drafts when confidence is between the draft and auto-send thresholds", () => {
    const d = decide({ understanding: u("fee_inquiry", 0.95), retrieval: src(0.7), policy: P, mode: "agent" });
    expect(d.action).toBe("draft");
  });

  it("falls back and never guesses when there is no source", () => {
    expect(decide({ understanding: u("fx_rate", 0.95), retrieval: null, policy: P, mode: "agent" }).action).toBe("fallback");
    expect(decide({ understanding: u("fee_inquiry", 0.95), retrieval: src(0.4), policy: P, mode: "agent" }).action).toBe("fallback");
  });

  it("uses the weaker of understanding and source confidence", () => {
    const d = decide({ understanding: u("fee_inquiry", 0.5), retrieval: src(0.99), policy: P, mode: "agent" });
    expect(d.action).toBe("fallback");
  });

  it("a stricter per-intent threshold turns an auto-send into a draft (live policy change)", () => {
    const strict: Policy = { ...P, perIntent: { fee_inquiry: 0.97 } };
    expect(decide({ understanding: u("fee_inquiry", 0.99), retrieval: src(0.93), policy: P, mode: "agent" }).action).toBe("auto_send");
    expect(decide({ understanding: u("fee_inquiry", 0.99), retrieval: src(0.93), policy: strict, mode: "agent" }).action).toBe("draft");
  });

  it("warns on phishing checks and allows greetings without a source", () => {
    expect(decide({ understanding: u("phishing_check"), retrieval: null, policy: P, mode: "agent" }).policyId).toBe("P-08");
    expect(decide({ understanding: u("greeting"), retrieval: null, policy: P, mode: "agent" }).action).toBe("auto_send");
  });
});

describe("checkOutbound()", () => {
  const bad = [
    "Please share your OTP with me",
    "Send me your PIN so I can verify you",
    "Can you provide the one-time code we texted?",
    "Reply with your card number",
    "Enter your password to continue",
    "We will refund the fee today",
    "I'll reimburse you right away",
  ];
  const good = [
    "We never ask for one-time codes.",
    "Please don't share your OTP with anyone.",
    "Do not share your PIN or password, even with us.",
    "Never give your password to anyone who calls.",
    "You did the right thing. I've locked your card.",
    "A colleague will review whether a refund is possible.",
    "International wires cost $45.",
  ];
  it.each(bad)("blocks: %s", (t) => expect(checkOutbound(t).ok).toBe(false));
  it.each(good)("allows: %s", (t) => expect(checkOutbound(t).ok).toBe(true));
  it("allows refund language only when a human explicitly sends it", () => {
    expect(checkOutbound("I'll refund the fee as a courtesy.", { allowRefundLanguage: true }).ok).toBe(true);
  });
});

describe("windowOpen()", () => {
  const now = 1_700_000_000_000;
  it("is open within 24h and closed after", () => {
    expect(windowOpen(now - 1000, now)).toBe(true);
    expect(windowOpen(now - WINDOW_MS + 1, now)).toBe(true);
    expect(windowOpen(now - WINDOW_MS - 1, now)).toBe(false);
  });
  it("is closed when the customer never wrote", () => {
    expect(windowOpen(null, now)).toBe(false);
    expect(windowOpen(undefined, now)).toBe(false);
  });
});

describe("domains", () => {
  const official = ["ravenwoodbank.com"];
  it("extracts domains from text", () => {
    expect(extractDomains('Verify now at ravenw00d-verify.com/login or www.example.org')).toEqual(["ravenw00d-verify.com", "www.example.org"]);
  });
  it("accepts the official domain and its subdomains", () => {
    expect(checkDomain("ravenwoodbank.com", official).verdict).toBe("official");
    expect(checkDomain("secure.ravenwoodbank.com", official).verdict).toBe("official");
  });
  it.each(["ravenw00d-verify.com", "ravenwoodbank.co", "ravenwood-bank.com", "ravenwoodbank.com.evil.net", "rav3nwoodbank.com"])(
    "flags lookalike %s",
    (d) => expect(checkDomain(d, official).verdict).toBe("lookalike"),
  );
  it("treats unrelated domains as unrelated", () => {
    expect(checkDomain("wikipedia.org", official).verdict).toBe("unrelated");
  });
});
