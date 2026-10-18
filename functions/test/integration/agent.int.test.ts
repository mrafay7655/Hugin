import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliver, OutboundBlocked } from "../../src/agent/outbound";
import { seedDemoData } from "../../src/seed/demo";
import { handleWhatsAppEvents } from "../../src/ingest/whatsapp";
import { parseWebhook } from "../../src/whatsapp/parse";
import { conversations, customers, kb, messages, policyDoc } from "../../src/lib/paths";
import type { ConversationDoc, CustomerDoc } from "../../src/lib/model";
import { allAlerts, allAudit, allCases, cardLocked, makeCtx, send, snapshot } from "./helpers";

const ctx = makeCtx();

beforeAll(async () => {
  await seedDemoData(ctx);
});

describe("J1: scam call reported by voice message", () => {
  it("replies, locks the card, opens a P2 fraud case, alerts and audits", async () => {
    const { convId } = await send(ctx, "c1", "whatsapp", "Someone just called saying they're from the bank and asked for my one-time code. I didn't give it. Is my account safe?", { kind: "voice", voiceSecs: 14 });
    const s = await snapshot(ctx, convId);

    expect(s.conv.decision).toBe("fraud_risk");
    expect(s.conv.status).toBe("fraud");
    expect(s.conv.caseId).toMatch(/^FR-\d+$/);
    expect(s.conv.thinking).toBe(false);
    expect(await cardLocked(ctx, "c1")).toBe(true);

    expect(s.outs).toHaveLength(1);
    expect(s.outs[0].text).toContain("locked your card");
    expect(s.outs[0].author).toBe("ai");
    expect(s.outs[0].cite).toEqual({ doc: "Fraud Playbook", section: "§2.1" });

    expect(s.lastTrace.policyId).toBe("P-07");
    expect(s.lastTrace.tools).toEqual(expect.arrayContaining(["lock_card", "create_case"]));
    expect(s.lastTrace.steps.map((x) => x.label)).toEqual(["Understood", "Retrieved", "Decided", "Acted"]);

    expect((await allCases(ctx)).some((c) => c.id === s.conv.caseId)).toBe(true);
    expect((await allAlerts(ctx)).some((a) => /Fraud team notified/.test(String(a.text)))).toBe(true);
    expect((await allAudit(ctx)).some((a) => a.action === "tool" && String(a.detail).startsWith("lock_card"))).toBe(true);

    // the inbound message is marked handled
    expect(s.msgs.find((m) => m.dir === "in")!.processed).toBe(true);
  });
});

describe("J2: fee question, then something with no approved source", () => {
  it("answers from the fee schedule with a citation", async () => {
    const { convId } = await send(ctx, "c2", "instagram", "What's the fee for an international wire?");
    const s = await snapshot(ctx, convId);
    expect(s.conv.decision).toBe("auto_resolved");
    expect(s.conv.status).toBe("resolved");
    expect(s.outs[0].text).toContain("$45");
    expect(s.outs[0].cite).toEqual({ doc: "Fee Schedule", section: "§4.2" });
  });

  it("refuses to guess an exchange rate", async () => {
    const { convId } = await send(ctx, "c2", "instagram", "And today's exchange rate?");
    const s = await snapshot(ctx, convId);
    expect(s.conv.decision).toBe("no_source");
    const last = s.outs[s.outs.length - 1];
    expect(last.text).toMatch(/won't guess/);
    expect(last.text).not.toMatch(/\d+\.\d+/); // no invented rate
    expect(s.lastTrace.policyId).toBe("P-02");
  });

  it("never cites the retired 2024 FAQ", async () => {
    const { convId } = await send(ctx, "c9", "whatsapp", "What is the fee for an international wire?");
    const s = await snapshot(ctx, convId);
    expect(s.outs.at(-1)!.text).not.toContain("$35");
  });
});

describe("J3: forwarded phishing screenshot", () => {
  it("flags the lookalike, asks with buttons, and escalates P1 if details were entered", async () => {
    const first = await send(ctx, "c3", "facebook", "Is this text really from you?", { kind: "image", imageText: "Ravenwood: your account is LOCKED. Verify now at ravenw00d-verify.com" });
    let s = await snapshot(ctx, first.convId);
    expect(s.conv.decision).toBe("phishing");
    expect(s.outs[0].text).toContain("ravenw00d-verify.com");
    expect(s.outs[0].buttons).toEqual(["No, I didn't", "Yes, I did"]);
    expect(s.lastTrace.steps.some((x) => x.label === "Checked" && /lookalike/.test(x.detail))).toBe(true);
    expect(await cardLocked(ctx, "c3")).toBe(false); // warning alone must not lock the card

    const second = await send(ctx, "c3", "facebook", "Yes, I did");
    s = await snapshot(ctx, second.convId);
    expect(s.conv.decision).toBe("fraud_risk");
    expect(s.conv.caseId).toMatch(/^FR-/);
    expect(await cardLocked(ctx, "c3")).toBe(true);
    const c = (await allCases(ctx)).find((x) => x.id === s.conv.caseId)!;
    expect(c.priority).toBe("P1");
  });

  it("reassures and resolves when no details were entered", async () => {
    await send(ctx, "c5", "x", "Is this text really from you?", { kind: "image", imageText: "Verify at ravenw00d-verify.com" });
    const { convId } = await send(ctx, "c5", "x", "No, I didn't");
    const s = await snapshot(ctx, convId);
    expect(s.conv.decision).toBe("auto_resolved");
    expect(s.conv.status).toBe("resolved");
    expect(await cardLocked(ctx, "c5")).toBe(false);
  });
});

describe("J4: account change always waits for a human", () => {
  it("sends only a holding reply and queues a draft for approval", async () => {
    const { convId } = await send(ctx, "c4", "telegram", "I need to change the phone number on my account.");
    const s = await snapshot(ctx, convId);
    expect(s.conv.decision).toBe("draft_ready");
    expect(s.conv.status).toBe("needs_human");
    expect(s.conv.approval?.draft).toContain("verify your identity");
    expect(s.outs).toHaveLength(1);
    expect(s.outs[0].text).toContain("a colleague will verify your identity");
    expect(s.lastTrace.policyId).toBe("P-04");
    // the draft must NOT have been sent
    expect(s.outs.every((m) => m.text !== s.conv.approval!.draft)).toBe(true);
  });
});

describe("governance controls", () => {
  it("stays silent when a human has taken over", async () => {
    await send(ctx, "c10", "instagram", "hello");
    const convId = "c10_instagram";
    await conversations(ctx.db, ctx.orgId).doc(convId).update({ mode: "human", assignee: "Dana Brooks" });
    const before = (await snapshot(ctx, convId)).outs.length;
    await send(ctx, "c10", "instagram", "What's the fee for an international wire?");
    const s = await snapshot(ctx, convId);
    expect(s.outs).toHaveLength(before); // no new agent reply
    expect(s.msgs.filter((m) => m.dir === "in").every((m) => m.processed)).toBe(true);
    expect(s.conv.unread).toBe(true);
    await conversations(ctx.db, ctx.orgId).doc(convId).update({ mode: "agent", assignee: null });
  });

  it("a stricter threshold turns an auto-send into a draft on the very next message", async () => {
    await policyDoc(ctx.db, ctx.orgId).set({ perIntent: { fee_inquiry: 0.99, knowledge_question: 0.99 }, autoSend: 0.85, draft: 0.6, alwaysHuman: [], blocked: [] });
    const { convId } = await send(ctx, "c6", "telegram", "What's the fee for an international wire?");
    const s = await snapshot(ctx, convId);
    expect(s.conv.decision).toBe("draft_ready");
    expect(s.conv.approval?.draft).toContain("$45");
    await seedDemoData(ctx); // restore default policy
  });

  it("blocks an outbound message that asks for a one-time code, and audits it", async () => {
    const conv = (await conversations(ctx.db, ctx.orgId).doc("c1_whatsapp").get()).data() as ConversationDoc;
    const customer = { id: "c1", ...((await customers(ctx.db, ctx.orgId).doc("c1").get()).data() as CustomerDoc) };
    await expect(deliver(ctx, { convId: "c1_whatsapp", conv, customer, text: "Please share your OTP so I can verify you", author: "ai" })).rejects.toBeInstanceOf(OutboundBlocked);
    expect((await allAudit(ctx)).some((a) => a.action === "blocked")).toBe(true);
  });

  it("refuses free-form WhatsApp replies once the 24-hour window has closed", async () => {
    const stale: ConversationDoc = { ...((await conversations(ctx.db, ctx.orgId).doc("c1_whatsapp").get()).data() as ConversationDoc), transport: "whatsapp", lastCustomerMessageAt: Date.now() - 25 * 3_600_000 };
    const customer = { id: "c1", ...((await customers(ctx.db, ctx.orgId).doc("c1").get()).data() as CustomerDoc) };
    const err = await deliver(ctx, { convId: "c1_whatsapp", conv: stale, customer, text: "Hello again", author: "human", authorName: "Dana" }).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundBlocked);
    expect((err as OutboundBlocked).reason).toBe("window");
  });
});

describe("resilience", () => {
  it("two messages at once are both handled exactly once (lease)", async () => {
    const a = await import("../../src/ingest/record");
    const base = { customerId: "c8", channel: "x" as const, transport: "sim" as const, kind: "text" as const };
    await a.recordInbound(ctx, { ...base, text: "hello", at: Date.now() });
    await a.recordInbound(ctx, { ...base, text: "What's the fee for an international wire?", at: Date.now() + 1 });
    const { processConversation } = await import("../../src/agent/run");
    await Promise.all([processConversation(ctx, "c8_x"), processConversation(ctx, "c8_x"), processConversation(ctx, "c8_x")]);
    const s = await snapshot(ctx, "c8_x");
    const ins = s.msgs.filter((m) => m.dir === "in");
    expect(ins.every((m) => m.processed)).toBe(true);
    const replies = s.outs.filter((m) => m.text.includes("$45"));
    expect(replies).toHaveLength(1); // not answered twice
    expect(s.conv.agentLease).toBeNull();
  });

  it("hands over safely instead of going silent when the pipeline throws", async () => {
    await kb(ctx.db, ctx.orgId).doc("broken").set({ title: "Broken", status: "active" }); // no sections: retrieval will throw
    const { convId } = await send(ctx, "c7", "instagram", "What's the fee for an international wire?");
    await kb(ctx.db, ctx.orgId).doc("broken").delete();
    const s = await snapshot(ctx, convId);
    expect(s.conv.decision).toBe("needs_human");
    expect(s.conv.approval?.reason).toMatch(/Agent error/);
    expect(s.outs.at(-1)!.text).toContain("asked a colleague");
    expect(s.lastTrace.policyId).toBe("P-99");
    expect((await allAudit(ctx)).some((a) => a.action === "error")).toBe(true);
  });
});

describe("WhatsApp webhook ingestion", () => {
  const payload = (id: string, text: string) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "W", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PN" }, contacts: [{ profile: { name: "Nora Quinn" }, wa_id: "15551230001" }], messages: [{ from: "15551230001", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hello" } }] } }] }],
  });

  it("creates the customer and conversation and is idempotent on Meta retries", async () => {
    const events = parseWebhook(payload("wamid.RETRY1", "hello"));
    const r1 = await handleWhatsAppEvents(ctx, events);
    const r2 = await handleWhatsAppEvents(ctx, events);
    expect(r1).toMatchObject({ stored: 1, duplicates: 0 });
    expect(r2).toMatchObject({ stored: 0, duplicates: 1 });
    const cust = (await customers(ctx.db, ctx.orgId).doc("wa_15551230001").get()).data() as CustomerDoc;
    expect(cust.name).toBe("Nora Quinn");
    expect(cust.phoneMasked).not.toContain("15551230001"); // never show the raw number
    const msgs = await messages(ctx.db, ctx.orgId, "wa_15551230001_whatsapp").get();
    expect(msgs.size).toBe(1);
    const conv = (await conversations(ctx.db, ctx.orgId).doc("wa_15551230001_whatsapp").get()).data() as ConversationDoc;
    expect(conv.transport).toBe("whatsapp");
    expect(conv.lastCustomerMessageAt).toBeGreaterThan(0);
  });

  it("applies delivery statuses in order and never moves a message backwards", async () => {
    const { waIndex } = await import("../../src/lib/paths");
    const ref = await messages(ctx.db, ctx.orgId, "wa_15551230001_whatsapp").add({ dir: "out", author: "ai", kind: "text", text: "hi", at: Date.now(), status: "sent", wamid: "wamid.OUT1" });
    await waIndex(ctx.db).doc("wamid.OUT1").set({ orgId: ctx.orgId, convId: "wa_15551230001_whatsapp", msgId: ref.id });
    const st = (status: string, ts: number) => parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN" }, statuses: [{ id: "wamid.OUT1", status, timestamp: String(ts), recipient_id: "15551230001" }] } }] }] });
    await handleWhatsAppEvents(ctx, st("read", 3));
    await handleWhatsAppEvents(ctx, st("delivered", 2)); // arrives late
    expect(((await ref.get()).data() as { status: string }).status).toBe("read");
  });
});

beforeEach(() => {
  /* each test sets up its own state; the seed provides customers, KB and policy */
});
