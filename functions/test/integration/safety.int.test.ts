import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, approveDraft, escalateToFraud, simulateInbound, unlockCard, type Actor } from "../../src/actions/manager";
import { deliver, OutboundBlocked } from "../../src/agent/outbound";
import { processConversation } from "../../src/agent/run";
import { recordInbound } from "../../src/ingest/record";
import { seedDemoData } from "../../src/seed/demo";
import { conversations, customers, messages, traces } from "../../src/lib/paths";
import type { ConversationDoc, CustomerDoc } from "../../src/lib/model";
import { allAlerts, allAudit, allCases, cardLocked, clearFirestore, makeCtx, send, snapshot } from "./helpers";

const ctx = makeCtx();
const actor: Actor = { uid: "u1", name: "Muhammad Rafay", email: "muhammad.rafay@demo.com" };

const customer = (name: string, over: Partial<CustomerDoc> = {}): CustomerDoc => ({
  name, initials: "X", color: ["#EFEFF1", "#3F3F46"], phoneMasked: "•••", tier: "Everyday", since: 2024, city: "", language: "en", csat: 0, churn: "Low", segment: "x", traits: [], summary: "", ...over,
});

beforeAll(async () => {
  await seedDemoData(ctx);
});
afterAll(clearFirestore);

describe("unconfirmed fraud signals go to a person and lock nothing (P-05)", () => {
  it("a mention of a caller and a PIN is reviewed, not locked", async () => {
    const { convId } = await send(ctx, "c5", "whatsapp", "A caller mentioned my PIN");
    const s = await snapshot(ctx, convId);
    expect(s.lastTrace.policyId).toBe("P-05");
    expect(s.conv.status).toBe("needs_human");
    expect(s.conv.approval?.reason).toBe("Possible fraud signal");
    expect(s.conv.caseId ?? null).toBeNull();
    expect(await cardLocked(ctx, "c5")).toBe(false);
    expect(s.outs).toHaveLength(1);
    expect(s.outs[0].text).toMatch(/colleague/);
    expect((await allAlerts(ctx)).some((a) => /needs review/.test(String(a.text)))).toBe(true);
  });

  it.each([
    "I forgot my PIN, can someone call me?",
    "Can I change my password by text?",
    "In my opinion someone should call me back",
    "Yes I did pay my bill on time",
  ])("an ordinary message does not lock a card or open a case: %s", async (text) => {
    const { convId } = await send(ctx, "c6", "telegram", text);
    const s = await snapshot(ctx, convId);
    expect(await cardLocked(ctx, "c6")).toBe(false);
    expect(s.conv.status).not.toBe("fraud");
    expect(s.conv.caseId ?? null).toBeNull();
    expect(s.lastTrace.policyId).not.toBe("P-07");
  });

  it("a clear request from a caller still locks at once (P-07)", async () => {
    const { convId } = await send(ctx, "c4", "whatsapp", "A guy called and asked for my PIN");
    const s = await snapshot(ctx, convId);
    expect(s.lastTrace.policyId).toBe("P-07");
    expect(await cardLocked(ctx, "c4")).toBe(true);
    expect(s.conv.caseId).toMatch(/^FR-/);
  });
});

describe("button answers", () => {
  it("only an answer to buttons we offered counts, and a tap is recognised", async () => {
    const first = await send(ctx, "c7", "facebook", "Is this real?", { kind: "image", imageText: "Your account is LOCKED. Verify at ravenw00d-verify.com" });
    expect((await snapshot(ctx, first.convId)).outs[0].buttons).toEqual(["No, I didn't", "Yes, I did"]);
    const { convId } = await recordInbound(ctx, { customerId: "c7", channel: "facebook", transport: "sim", text: "Yes, I did", kind: "text", at: ctx.now(), viaButton: true });
    await processConversation(ctx, convId);
    const s = await snapshot(ctx, convId);
    expect(s.conv.decision).toBe("fraud_risk");
    expect(await cardLocked(ctx, "c7")).toBe(true);
  });

  it("'Yes I did' with no buttons on the table is not an answer", async () => {
    await customers(ctx.db, ctx.orgId).doc("t_nobuttons").set(customer("Nia", { sample: true }));
    const { convId } = await send(ctx, "t_nobuttons", "telegram", "Yes, I did");
    expect(await cardLocked(ctx, "t_nobuttons")).toBe(false);
    expect((await snapshot(ctx, convId)).conv.caseId ?? null).toBeNull();
  });
});

describe("unlocking a card", () => {
  it("a manager can unlock a locked card; it is audited; the agent never does", async () => {
    const convId = "c4_whatsapp";
    expect(await cardLocked(ctx, "c4")).toBe(true);
    await unlockCard(ctx, actor, { convId });
    expect(await cardLocked(ctx, "c4")).toBe(false);
    expect((await allAudit(ctx)).some((a) => a.action === "unlock-card" && a.actor === actor.email)).toBe(true);
    expect((await snapshot(ctx, convId)).msgs.some((m) => /unlocked the card/.test(m.text))).toBe(true);
    await expect(unlockCard(ctx, actor, { convId })).rejects.toThrow(/not locked/);
    // a later ordinary message does not lock it again
    await send(ctx, "c4", "whatsapp", "What's the fee for an international wire?");
    expect(await cardLocked(ctx, "c4")).toBe(false);
  });

  it("sending a conversation to Fraud also locks the card, like the agent's own fraud path", async () => {
    const { convId } = await send(ctx, "c10", "telegram", "hello");
    expect(await cardLocked(ctx, "c10")).toBe(false);
    const { caseId } = await escalateToFraud(ctx, actor, { convId });
    expect(caseId).toMatch(/^FR-/);
    expect(await cardLocked(ctx, "c10")).toBe(true);
    expect((await allCases(ctx)).some((c) => c.id === caseId)).toBe(true);
  });
});

describe("approving a draft", () => {
  const convId = "c8_x";
  const sent = async () => (await snapshot(ctx, convId)).msgs.filter((m) => m.author === "human" && m.dir === "out").length;

  it("a blocked draft goes back to the queue and nothing is sent", async () => {
    const before = await sent();
    await expect(approveDraft(ctx, actor, { convId, text: "Please reply with your PIN so I can check" })).rejects.toBeInstanceOf(OutboundBlocked);
    const s = await snapshot(ctx, convId);
    expect(s.conv.approval).not.toBeNull();
    expect(await sent()).toBe(before);
  });

  it("two managers approving at the same moment send it once", async () => {
    const before = await sent();
    const results = await Promise.allSettled([approveDraft(ctx, actor, { convId }), approveDraft(ctx, { ...actor, name: "Other" }, { convId })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ActionError);
    expect(await sent()).toBe(before + 1);
    expect((await snapshot(ctx, convId)).conv.approval).toBeNull();
  });
});

describe("demo tools cannot touch real customers", () => {
  it("simulated messages are refused for a customer who is not a sample", async () => {
    await customers(ctx.db, ctx.orgId).doc("tg_real1").set(customer("Real Person"));
    await expect(simulateInbound(ctx, actor, { customerId: "tg_real1", channel: "telegram", text: "hi" })).rejects.toThrow(/sample customers/);
  });

  it("a simulated message never turns a real conversation into a simulated one", async () => {
    await customers(ctx.db, ctx.orgId).doc("tg_real2").set(customer("Real Two"));
    await recordInbound(ctx, { customerId: "tg_real2", channel: "telegram", transport: "telegram", text: "hello", kind: "text", at: ctx.now() });
    await recordInbound(ctx, { customerId: "tg_real2", channel: "telegram", transport: "sim", text: "hello again", kind: "text", at: ctx.now() });
    const conv = (await conversations(ctx.db, ctx.orgId).doc("tg_real2_telegram").get()).data() as ConversationDoc;
    expect(conv.transport).toBe("telegram");
  });
});

describe("what the customer's own words can and cannot do", () => {
  it("a display name that looks like a link or a lookalike domain is never echoed back", async () => {
    await customers(ctx.db, ctx.orgId).doc("t_evilname").set(customer("ravenw00d-verify.com", { sample: true }));
    const { convId } = await send(ctx, "t_evilname", "telegram", "hello");
    const reply = (await snapshot(ctx, convId)).outs[0];
    expect(reply.text).toMatch(/^Hi there!/);
    expect(reply.text).not.toContain("ravenw00d");
  });

  it("the agent may not send a link to anywhere but the bank, but may warn about a lookalike", async () => {
    const conv = (await conversations(ctx.db, ctx.orgId).doc("c7_instagram").get()).data() as ConversationDoc;
    const cu = { id: "c7", ...((await customers(ctx.db, ctx.orgId).doc("c7").get()).data() as CustomerDoc) };
    const base = { convId: "c7_instagram", conv, customer: cu, author: "ai" as const };
    await expect(deliver(ctx, { ...base, text: "Please see example-offers.com for details" })).rejects.toBeInstanceOf(OutboundBlocked);
    await expect(deliver(ctx, { ...base, text: "Please log in at ravenw00d-verify.com" })).rejects.toBeInstanceOf(OutboundBlocked);
    await expect(deliver(ctx, { ...base, text: "Rates are at ravenwoodbank.com/rates" })).resolves.toBeTruthy();
    await expect(deliver(ctx, { ...base, text: "ravenw00d-verify.com is not ours. Don't tap it.", warnsAbout: ["ravenw00d-verify.com"] })).resolves.toBeTruthy();
  });

  it("a message that was already handled is not answered twice if its run is repeated", async () => {
    const { convId, msgId } = await send(ctx, "c9", "whatsapp", "What is the fee for an international wire?");
    const before = (await snapshot(ctx, convId)).outs.length;
    await messages(ctx.db, ctx.orgId, convId).doc(msgId).update({ processed: false }); // as if the run died before saving
    await processConversation(ctx, convId);
    const s = await snapshot(ctx, convId);
    expect(s.outs.length).toBe(before);
    expect(s.msgs.find((m) => m.id === msgId)!.processed).toBe(true);
    expect((await traces(ctx.db, ctx.orgId, convId).get()).size).toBe(s.traces.length);
  });
});
