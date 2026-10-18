import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulateComment, simulateInbound, type Actor } from "../../src/actions/manager";
import { processConversation } from "../../src/agent/run";
import { dayKey } from "../../src/agent/metrics";
import { seedDemoData } from "../../src/seed/demo";
import { comments, conversations, customers, messages, org } from "../../src/lib/paths";
import type { Ctx } from "../../src/agent/context";
import type { ConversationDoc, CustomerDoc, MessageDoc } from "../../src/lib/model";
import { clearFirestore, makeCtx } from "./helpers";

/** A stand-in for a Cloud Storage bucket: keeps files in memory. */
function fakeBucket() {
  const files = new Map<string, { data: Buffer; contentType?: string }>();
  const bucket = {
    files,
    file: (path: string) => ({
      save: async (data: Buffer, o?: { contentType?: string }) => { files.set(path, { data, contentType: o?.contentType }); },
      download: async () => { const f = files.get(path); if (!f) throw new Error("no such file"); return [f.data]; },
    }),
  };
  return bucket;
}

const judge: Actor = { uid: "judge-uid-1", name: "Hackathon Judge", email: "judge@demo.com", role: "judge" };
const metrics = async (ctx: Ctx) => (await org(ctx.db, ctx.orgId).collection("metrics").doc(dayKey(ctx.now())).get()).data() ?? {};
const healthOf = async (ctx: Ctx, id: string) => (await org(ctx.db, ctx.orgId).collection("health").doc(id).get()).data();

describe("the Agent dashboard's numbers", () => {
  const ctx = makeCtx();
  beforeAll(async () => {
    await clearFirestore();
    await seedDemoData(ctx);
  });
  afterAll(clearFirestore);

  it("seeding sample data records nothing: the dashboard shows real use only", async () => {
    expect(await metrics(ctx)).toEqual({});
    expect(await healthOf(ctx, "comment-agent")).toBeUndefined();
    expect(await healthOf(ctx, "customer-agent")).toBeUndefined();
  });

  it("a handled message counts the run, its decision and outcome, and marks the agents healthy", async () => {
    const { convId } = await simulateInbound(ctx, judge, { customerId: "c1", channel: "whatsapp", text: "Someone called saying they're from the bank and asked for my one-time code" });
    await processConversation(ctx, convId);
    const m = await metrics(ctx);
    expect(m.runs).toBe(1);
    expect(m.runsSimulated).toBe(1);
    expect(m.policy["P-07"]).toBe(1);
    expect(m.action.safety_and_escalate).toBe(1);
    expect(m.understoodByRules).toBe(1); // no model in tests
    expect(m.casesOpened).toBe(1);
    expect(m.cardsLocked).toBe(1);
    expect(m.repliesSent).toBe(1);
    expect(m.messagesSent).toBe(1);
    expect(m.sent.whatsapp).toBe(1);
    expect(m.firstReplyMsSum).toBeGreaterThanOrEqual(0);
    expect((await healthOf(ctx, "customer-agent"))?.lastOkAt).toBeGreaterThan(0);
    expect((await healthOf(ctx, "policy-engine"))?.lastDetail).toMatch(/^P-07/);
    expect((await healthOf(ctx, "output-guard"))?.lastOkAt).toBeGreaterThan(0);
  });

  it("a model failure is counted and shows on the customer agent as an error, while the message is still handled", async () => {
    const failing = { ...ctx, understanderOverride: async () => { throw new Error("vertex unavailable"); } };
    const { convId } = await simulateInbound(failing, judge, { customerId: "c2", channel: "instagram", text: "What's the fee for an international wire?" });
    await processConversation(failing, convId);
    expect((await metrics(ctx)).modelErrors).toBe(1);
    const h = await healthOf(ctx, "customer-agent");
    expect(h?.lastError).toMatch(/Gemini unavailable/);
    expect(h?.lastErrorAt).toBeGreaterThanOrEqual(h?.lastOkAt);
    const s = (await conversations(ctx.db, ctx.orgId).doc(convId).get()).data() as ConversationDoc;
    expect(s.decision).toBe("auto_resolved"); // the rules still answered
  });

  it("a guard block is counted", async () => {
    const before = (await metrics(ctx)).guardBlocks ?? 0;
    const { sendHuman } = await import("../../src/actions/manager");
    await expect(sendHuman(ctx, { ...judge, role: "manager" }, { convId: "c2_instagram", text: "whats ur pin" })).rejects.toThrow();
    expect((await metrics(ctx)).guardBlocks).toBe(before + 1);
    expect((await metrics(ctx)).guardBlocksPeople).toBeGreaterThanOrEqual(1);
  });

  it("a simulated comment counts and marks the comment agent; its origin is recorded", async () => {
    const { id } = await simulateComment(ctx, judge, { platform: "instagram", text: "Love the new app, super fast!" });
    const c = (await comments(ctx.db, ctx.orgId).doc(id).get()).data()!;
    expect(c.origin).toBe("simulated");
    const m = await metrics(ctx);
    expect(m.comments).toBe(1);
    expect(m.commentsSimulated).toBe(1);
    expect((await healthOf(ctx, "comment-agent"))?.lastOkAt).toBeGreaterThan(0);
  });

  it("seeded sample comments and conversations are labelled sample", async () => {
    const seeded = (await comments(ctx.db, ctx.orgId).where("sample", "==", true).limit(1).get()).docs[0].data();
    expect(seeded.origin).toBe("sample");
    expect(((await conversations(ctx.db, ctx.orgId).doc("c8_x").get()).data() as ConversationDoc).origin).toBe("sample");
  });
});

describe("the judge's private web chat", () => {
  const bucket = fakeBucket();
  const ctx = makeCtx({ bucket: bucket as unknown as Ctx["bucket"] });
  beforeAll(async () => {
    await clearFirestore();
    await seedDemoData(ctx);
  });
  afterAll(clearFirestore);

  it("'me' creates a private sample customer for the signed-in person, once", async () => {
    const a = await simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "hello" });
    const b = await simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "hello again" });
    expect(a.convId).toBe(`sim_${judge.uid}_webchat`);
    expect(b.convId).toBe(a.convId);
    const cu = (await customers(ctx.db, ctx.orgId).doc(`sim_${judge.uid}`).get()).data() as CustomerDoc;
    expect(cu.name).toBe("Hackathon (web chat)");
    expect(cu.sample).toBe(true);
    const conv = (await conversations(ctx.db, ctx.orgId).doc(a.convId).get()).data() as ConversationDoc;
    expect([conv.transport, conv.origin, conv.channel]).toEqual(["sim", "simulated", "webchat"]);
  });

  it("two judges get two separate sandboxes", async () => {
    const other = await simulateInbound(ctx, { ...judge, uid: "judge-uid-2", name: "Second Judge" }, { customerId: "me", channel: "webchat", text: "hi" });
    expect(other.convId).toBe("sim_judge-uid-2_webchat");
  });

  it("a screenshot is stored, marked as an image, and handed to the agent from storage", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const { convId, msgId } = await simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "is this real?", media: { mimeType: "image/png", data: png.toString("base64") } });
    const m = (await messages(ctx.db, ctx.orgId, convId).doc(msgId).get()).data() as MessageDoc;
    expect(m.kind).toBe("image");
    expect(m.mediaPath).toMatch(/^orgs\/ravenwood\/media\/sim_/);
    expect(bucket.files.get(m.mediaPath!)?.contentType).toBe("image/png");

    let seen: { mimeType: string; bytes: number } | null = null;
    const watching = { ...ctx, understanderOverride: async (i: { media?: { mimeType: string; data: Buffer } }) => {
      seen = i.media ? { mimeType: i.media.mimeType, bytes: i.media.data.byteLength } : null;
      return { understanding: { intent: "phishing_check" as const, confidence: 0.9, sentiment: "worried" as const, language: "en", urls: [], source: "gemini" as const }, toolCalls: [] };
    } };
    await processConversation(watching, convId);
    expect(seen).toEqual({ mimeType: "image/png", bytes: png.byteLength });
    expect((await metrics(ctx)).mediaRead).toBeGreaterThanOrEqual(1);
  });

  it("a voice note is marked as voice", async () => {
    const { convId, msgId } = await simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "", media: { mimeType: "audio/webm", data: Buffer.from("fake-audio").toString("base64") } });
    expect(((await messages(ctx.db, ctx.orgId, convId).doc(msgId).get()).data() as MessageDoc).kind).toBe("voice");
  });

  it("refuses files of a type or size that is not allowed", async () => {
    await expect(simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "x", media: { mimeType: "application/pdf", data: "AAAA" } })).rejects.toThrow();
    const big = Buffer.alloc(6 * 1024 * 1024 + 1).toString("base64");
    await expect(simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "x", media: { mimeType: "image/png", data: big } })).rejects.toThrow();
  });

  it("says plainly when Cloud Storage is not switched on", async () => {
    const noStorage = makeCtx();
    await expect(simulateInbound(noStorage, judge, { customerId: "me", channel: "webchat", text: "x", media: { mimeType: "image/png", data: "iVBORw0KGgo=" } })).rejects.toThrow(/Cloud Storage/);
  });
});

describe("uploads when the bucket cannot be reached", () => {
  const broken = { file: () => ({ save: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9199"); }, download: async () => [Buffer.alloc(0)] }) };
  const ctx = makeCtx({ bucket: broken as unknown as Ctx["bucket"] });
  beforeAll(async () => { await clearFirestore(); await seedDemoData(ctx); });
  afterAll(clearFirestore);
  it("says so plainly instead of failing with a vague error, and stores no message", async () => {
    await expect(simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "x", media: { mimeType: "image/png", data: "iVBORw0KGgo=" } })).rejects.toThrow(/Cloud Storage is not reachable/);
    expect((await messages(ctx.db, ctx.orgId, `sim_${judge.uid}_webchat`).get()).size).toBe(0);
  });
});

describe("Start over: clearing a judge's own sandbox", () => {
  const ctx = makeCtx();
  beforeAll(async () => { await clearFirestore(); await seedDemoData(ctx); });
  afterAll(clearFirestore);
  it("removes only that person's web chat, its traces and its card lock", async () => {
    const { clearSandbox } = await import("../../src/actions/manager");
    const mine = await simulateInbound(ctx, judge, { customerId: "me", channel: "webchat", text: "Someone called and asked for my one-time code" });
    const theirs = await simulateInbound(ctx, { ...judge, uid: "other-judge" }, { customerId: "me", channel: "webchat", text: "hello" });
    await processConversation(ctx, mine.convId);
    expect((await org(ctx.db, ctx.orgId).collection("cards").doc(`sim_${judge.uid}`).get()).data()?.locked).toBe(true);

    await clearSandbox(ctx, judge);
    expect((await conversations(ctx.db, ctx.orgId).doc(mine.convId).get()).exists).toBe(false);
    expect((await messages(ctx.db, ctx.orgId, mine.convId).get()).size).toBe(0);
    expect((await org(ctx.db, ctx.orgId).collection("cards").doc(`sim_${judge.uid}`).get()).exists).toBe(false);
    // someone else's sandbox and the sample data are untouched
    expect((await conversations(ctx.db, ctx.orgId).doc(theirs.convId).get()).exists).toBe(true);
    expect((await conversations(ctx.db, ctx.orgId).doc("c8_x").get()).exists).toBe(true);
  });
});
