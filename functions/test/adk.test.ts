import { BaseLlm, type LlmRequest, type LlmResponse } from "@google/adk";
import { describe, expect, it } from "vitest";
import { CLASSIFIER_MARK, INVESTIGATOR_MARK, pipelineModeFor, runUnderstanding } from "../src/agent/adk/pipeline";
import type { AdkDeps } from "../src/agent/adk/tools";
import { COMMENT_CLASSIFIER_MARK, classifyCommentWithAdk } from "../src/agent/adk/comments";
import { classifyComment, mergeClassification } from "../src/comments/classify";
import { mergeUnderstanding, understand } from "../src/agent/understand";
import type { Classification } from "../src/agent/schema";

/** A scripted stand-in for Gemini. No network, no credentials. */
class FakeLlm extends BaseLlm {
  seenByClassifier: string[] = [];
  constructor(
    private investigatorCalls: { name: string; args: Record<string, unknown> }[],
    private classification: Classification | (() => never),
  ) {
    super({ model: "fake-gemini" });
  }

  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    const system = JSON.stringify(req.config?.systemInstruction ?? "");
    const contents = req.contents ?? [];
    const last = contents[contents.length - 1];
    const sawToolResult = !!last?.parts?.some((p) => p.functionResponse);

    if (system.includes(INVESTIGATOR_MARK)) {
      if (!sawToolResult && this.investigatorCalls.length) {
        yield { content: { role: "model", parts: this.investigatorCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) } };
      } else {
        yield { content: { role: "model", parts: [{ text: "Findings: the link is a lookalike of the official domain. No policy source needed." }] } };
      }
      return;
    }
    if (system.includes(CLASSIFIER_MARK)) {
      this.seenByClassifier.push(JSON.stringify(contents));
      if (typeof this.classification === "function") this.classification();
      yield { content: { role: "model", parts: [{ text: JSON.stringify(this.classification) }] } };
      return;
    }
    throw new Error("unexpected agent in test");
  }

  async connect(): Promise<never> {
    throw new Error("live connections are not used");
  }
}

const deps: AdkDeps = {
  officialDomains: ["ravenwoodbank.com"],
  searchPolicy: async () => null,
  customerContext: async () => ({ tier: "Everyday", customerSinceYear: 2008, recentIntents: [], cardLocked: false }),
};

const phishing: Classification = {
  intent: "phishing_check", sentiment: "worried", language: "en", confidence: 0.96,
  transcript: "Your account is LOCKED. Verify at ravenw00d-verify.com", urls: ["ravenw00d-verify.com"],
};

describe("ADK understanding pipeline (fake Gemini)", () => {
  it("runs investigator tools, then returns structured output", async () => {
    const llm = new FakeLlm([{ name: "check_domain", args: { domain: "ravenw00d-verify.com" } }], phishing);
    const run = await runUnderstanding(llm, { text: "Is this real?", kind: "image" }, deps);

    expect(run.understanding.intent).toBe("phishing_check");
    expect(run.understanding.source).toBe("gemini");
    expect(run.understanding.urls).toEqual(["ravenw00d-verify.com"]);

    // the model's tool call really executed, against our real domain checker
    expect(run.toolCalls).toHaveLength(1);
    expect(run.toolCalls[0].name).toBe("check_domain");
    expect(run.toolCalls[0].args).toEqual({ domain: "ravenw00d-verify.com" });
    expect(JSON.stringify(run.toolCalls[0].result)).toContain("lookalike");
  });

  it("hands the investigator's findings to the classifier", async () => {
    const llm = new FakeLlm([{ name: "check_domain", args: { domain: "ravenw00d-verify.com" } }], phishing);
    await runUnderstanding(llm, { text: "Is this real?", kind: "text" }, deps, { mode: "full" });
    expect(llm.seenByClassifier.length).toBeGreaterThan(0);
    expect(llm.seenByClassifier[0]).toContain("lookalike of the official domain");
    expect(llm.seenByClassifier[0]).toContain("Is this real?");
  });

  it("works when the investigator calls no tools", async () => {
    const llm = new FakeLlm([], { ...phishing, intent: "greeting", urls: [] });
    const run = await runUnderstanding(llm, { text: "hello", kind: "text" }, deps, { mode: "full" });
    expect(run.toolCalls).toHaveLength(0);
    expect(run.understanding.intent).toBe("greeting");
  });

  it("rejects malformed model output instead of trusting it", async () => {
    const bad = { ...phishing, intent: "launch_missiles" } as unknown as Classification;
    const llm = new FakeLlm([], bad);
    await expect(runUnderstanding(llm, { text: "x", kind: "text" }, deps)).rejects.toThrow();
  });
});

describe("understand(): fail-safe behaviour", () => {
  const input = { text: "Someone called and asked for my one-time code", kind: "text" as const };

  it("a manipulated model cannot downgrade a fraud report", async () => {
    const llm = new FakeLlm([], { ...phishing, intent: "greeting", confidence: 0.99, urls: [] });
    const r = await understand((i) => runUnderstanding(llm, i, deps), input);
    expect(r.understanding.intent).toBe("otp_scam_report");
  });

  it("falls back to rules when the model errors", async () => {
    const r = await understand(async () => { throw new Error("vertex unavailable"); }, input);
    expect(r.understanding.intent).toBe("otp_scam_report");
    expect(r.understanding.source).toBe("heuristic");
    expect(r.modelError).toBe("vertex unavailable");
  });

  it("runs on rules alone when no model is configured", async () => {
    const r = await understand(null, input);
    expect(r.understanding.source).toBe("heuristic");
    expect(r.toolCalls).toEqual([]);
  });

  it("merge never lowers caution", () => {
    const m = mergeUnderstanding(
      { intent: "fee_inquiry", confidence: 0.99, sentiment: "neutral", language: "en", urls: [], source: "gemini" },
      { intent: "account_change", confidence: 0.95, sentiment: "neutral", language: "en", urls: [], source: "heuristic" },
    );
    expect(m.intent).toBe("account_change");
  });
});

/** A scripted Gemini for the comment classifier agent. */
class FakeCommentLlm extends BaseLlm {
  constructor(private out: Record<string, unknown>) { super({ model: "fake-gemini" }); }
  async *generateContentAsync(req: LlmRequest): AsyncGenerator<LlmResponse, void> {
    if (!JSON.stringify(req.config?.systemInstruction ?? "").includes(COMMENT_CLASSIFIER_MARK)) throw new Error("wrong agent");
    yield { content: { role: "model", parts: [{ text: JSON.stringify(this.out) }] } };
  }
  async connect(): Promise<never> { throw new Error("live connections are not used"); }
}
const modelComment = { sentiment: "positive", score: 0.8, emotion: "joy", topic: "card", intent: "praise", sarcasm: false, toxicity: 0, needsReply: false, riskFlag: false, riskReason: "", language: "en", urls: [] };

describe("comment classification through ADK (fake Gemini)", () => {
  it("returns the model's structured classification", async () => {
    const r = await classifyCommentWithAdk(new FakeCommentLlm(modelComment), "Loving the new card");
    expect(r).toMatchObject({ sentiment: "positive", intent: "praise", source: "gemini" });
  });
  it("rejects output outside the schema", async () => {
    await expect(classifyCommentWithAdk(new FakeCommentLlm({ ...modelComment, sentiment: "ecstatic" }), "x")).rejects.toThrow();
  });
  it("a model that misses a scam is overridden by the rules (risk is never downgraded)", async () => {
    const text = "You've won a $500 giveaway! Claim now at ravenw00d-rewards.com";
    const model = await classifyCommentWithAdk(new FakeCommentLlm(modelComment), text); // model says harmless praise
    const merged = mergeClassification(model, classifyComment(text));
    expect(merged.riskFlag).toBe(true);
    expect(merged.intent).toBe("scam_or_spam");
  });
});

describe("fast path: one Gemini call for a plain text message", () => {
  it("chooses the full pipeline only when there is something to investigate", () => {
    expect(pipelineModeFor({ text: "What's the fee for an international wire?", kind: "text" }, {})).toBe("fast");
    expect(pipelineModeFor({ text: "Is ravenw00d-verify.com real?", kind: "text" }, {})).toBe("full");
    expect(pipelineModeFor({ text: "", kind: "voice" }, {})).toBe("full");
    expect(pipelineModeFor({ text: "look", kind: "image" }, {})).toBe("full");
    expect(pipelineModeFor({ text: "hello", kind: "text" }, { GEMINI_PIPELINE: "full" })).toBe("full");
  });

  it("skips the investigator, hands the classifier the facts checked by code, and still returns structured output", async () => {
    const llm = new FakeLlm([{ name: "check_domain", args: { domain: "x.com" } }], { ...phishing, intent: "fee_inquiry", urls: [] });
    const withSource: AdkDeps = { ...deps, searchPolicy: async () => ({ doc: "Fee Schedule", section: "§4.2", text: "Outgoing international wires are $45 each.", score: 0.95 }) };
    const run = await runUnderstanding(llm, { text: "What's the fee for an international wire?", kind: "text" }, withSource);
    expect(run.mode).toBe("fast");
    expect(run.toolCalls).toHaveLength(0); // the investigator never ran
    expect(run.understanding.intent).toBe("fee_inquiry");
    expect(llm.seenByClassifier[0]).toContain("facts_checked_by_code");
    expect(llm.seenByClassifier[0]).toContain("Fee Schedule");
  });
});
