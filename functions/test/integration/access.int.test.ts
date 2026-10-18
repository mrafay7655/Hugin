import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addAllowedDomain, addInvite, approveDraft, hideComment, removeAllowedDomain, removeInvite, replyToComment, resetDemo, sendHuman, setMode, simulateInbound, type Actor,
} from "../../src/actions/manager";
import { seedDemoData } from "../../src/seed/demo";
import { comments, conversations, customers, org, posts } from "../../src/lib/paths";
import type { ConversationDoc } from "../../src/lib/model";
import { allAudit, clearFirestore, makeCtx } from "./helpers";

const revoked: string[] = [];
const accounts = {
  byEmail: { "ex@partner.io": "uid-ex", "sam@olddomain.com": "uid-sam", "still@olddomain.com": "uid-still" } as Record<string, string>,
  uidByEmail: async (e: string) => accounts.byEmail[e] ?? null,
  uidsByDomain: async (d: string) => Object.entries(accounts.byEmail).filter(([e]) => e.endsWith(`@${d}`)).map(([, u]) => u),
  revoke: async (uid: string) => { revoked.push(uid); },
};
const ctx = makeCtx({ accounts });
const manager: Actor = { uid: "u1", name: "Muhammad Rafay", email: "muhammad.rafay@demo.com", role: "manager" };
const judge: Actor = { uid: "u9", name: "Hackathon Judge", email: "judge@demo.com", role: "judge" };

afterAll(clearFirestore);

beforeEach(async () => {
  revoked.length = 0;
  await seedDemoData(ctx);
  await org(ctx.db, ctx.orgId).update({ allowedDomains: ["demo.com", "ravenwoodbank.com", "olddomain.com"] });
  const inv = org(ctx.db, ctx.orgId).collection("invites");
  for (const d of (await inv.get()).docs) await d.ref.delete();
  await inv.doc("ex@partner.io").set({ by: "t", at: 1, role: "manager" });
  const mem = org(ctx.db, ctx.orgId).collection("members");
  for (const d of (await mem.get()).docs) await d.ref.delete();
  await mem.doc("uid-ex").set({ email: "ex@partner.io", revoked: false });
  await mem.doc("uid-sam").set({ email: "sam@olddomain.com", revoked: false });
  await mem.doc("uid-still").set({ email: "still@olddomain.com", revoked: false });
});

const member = async (uid: string) => (await org(ctx.db, ctx.orgId).collection("members").doc(uid).get()).data();

describe("removing access ends sessions", () => {
  it("removing an invite revokes that person, marks the member, and audits it", async () => {
    await removeInvite(ctx, manager, { email: "ex@partner.io" });
    expect(revoked).toEqual(["uid-ex"]);
    expect((await member("uid-ex"))?.revoked).toBe(true);
    expect((await allAudit(ctx)).some((a) => a.action === "access" && /removed invite ex@partner.io · session ended/.test(String(a.detail)))).toBe(true);
  });

  it("removing a domain revokes everyone on it who is not covered another way", async () => {
    await org(ctx.db, ctx.orgId).collection("invites").doc("still@olddomain.com").set({ by: "t", at: 1, role: "manager" });
    await removeAllowedDomain(ctx, manager, { domain: "olddomain.com" });
    expect(revoked).toEqual(["uid-sam"]); // still@ keeps access through the invite
    expect((await member("uid-sam"))?.revoked).toBe(true);
    expect((await member("uid-still"))?.revoked).toBe(false);
  });

  it("removing an invite does not revoke a person whose domain is still approved", async () => {
    await org(ctx.db, ctx.orgId).update({ allowedDomains: ["demo.com", "partner.io"] });
    await removeInvite(ctx, manager, { email: "ex@partner.io" });
    expect(revoked).toEqual([]);
    expect((await member("uid-ex"))?.revoked).toBe(false);
  });

  it("you cannot remove your own invite", async () => {
    await org(ctx.db, ctx.orgId).collection("invites").doc("muhammad.rafay@demo.com").set({ by: "t", at: 1 });
    await expect(removeInvite(ctx, manager, { email: "muhammad.rafay@demo.com" })).rejects.toThrow(/lock yourself out/);
  });
});

describe("invites carry a role", () => {
  it("a judge invite is stored with its role; the default is manager", async () => {
    await addInvite(ctx, manager, { email: "Judge@Example.org", role: "judge" });
    await addInvite(ctx, manager, { email: "boss@example.org" });
    const inv = org(ctx.db, ctx.orgId).collection("invites");
    expect((await inv.doc("judge@example.org").get()).data()?.role).toBe("judge");
    expect((await inv.doc("boss@example.org").get()).data()?.role).toBe("manager");
  });
});

describe("a judge can try the demo but only on simulated data", () => {
  it("can act on a simulated conversation", async () => {
    await expect(approveDraft(ctx, judge, { convId: "c8_x" })).resolves.toBeUndefined();
  });

  it("can act on a Telegram demo conversation, but not on a WhatsApp one", async () => {
    await customers(ctx.db, ctx.orgId).doc("tg_real").set({ name: "Real", initials: "R", color: ["#fff", "#000"], phoneMasked: "@r", tier: "Everyday", since: 2026, city: "", language: "en", csat: 0, churn: "Low", segment: "x", traits: [], summary: "", tgId: "1" });
    const conv: ConversationDoc = {
      customerId: "tg_real", channel: "telegram", transport: "telegram", status: "open", decision: "auto_resolved", intent: "greeting", priority: 1, unread: false, thinking: false, mode: "agent", lastAt: 1, lastPreview: "", lastKind: "text", lastCustomerMessageAt: 1,
    };
    await conversations(ctx.db, ctx.orgId).doc("tg_real_telegram").set(conv);
    // Telegram demo chats are open to a judge: switching to human takes no outbound credentials, so it resolves.
    await expect(setMode(ctx, judge, { convId: "tg_real_telegram", human: true })).resolves.toBeUndefined();

    // WhatsApp reaches real phone numbers, so it stays a manager's.
    await customers(ctx.db, ctx.orgId).doc("wa_real").set({ name: "Real WA", initials: "R", color: ["#fff", "#000"], phoneMasked: "+1 ••• 1234", tier: "Everyday", since: 2026, city: "", language: "en", csat: 0, churn: "Low", segment: "x", traits: [], summary: "", waId: "15551234" });
    await conversations(ctx.db, ctx.orgId).doc("wa_real_whatsapp").set({ ...conv, customerId: "wa_real", channel: "whatsapp", transport: "whatsapp" });
    await expect(sendHuman(ctx, judge, { convId: "wa_real_whatsapp", text: "hello" })).rejects.toThrow(/not on WhatsApp/);
    await expect(approveDraft(ctx, judge, { convId: "wa_real_whatsapp" })).rejects.toThrow(/not on WhatsApp/);
    await expect(setMode(ctx, judge, { convId: "wa_real_whatsapp", human: true })).rejects.toThrow(/not on WhatsApp/);
  });

  it("can reply to a sample comment but not to a real one", async () => {
    const sample = (await comments(ctx.db, ctx.orgId).where("sample", "==", true).limit(1).get()).docs[0];
    await expect(replyToComment(ctx, judge, { commentId: sample.id, text: "Thanks for asking!" })).resolves.toBeUndefined();
    await comments(ctx.db, ctx.orgId).doc("instagram_real1").set({ ...sample.data(), sample: false, platform: "instagram", externalId: "real1", status: "new" });
    await expect(replyToComment(ctx, judge, { commentId: "instagram_real1", text: "Thanks!" })).rejects.toThrow(/sample comments/);
    await expect(hideComment(ctx, judge, { commentId: "instagram_real1", hidden: true })).rejects.toThrow(/sample comments/);
  });

  it("can use the simulator on sample customers", async () => {
    await expect(simulateInbound(ctx, judge, { customerId: "c2", channel: "instagram", text: "hello" })).resolves.toBeTruthy();
  });
});

describe("resetting the demo only touches sample data", () => {
  it("keeps real comments, real posts, and the approved domains and invites", async () => {
    await comments(ctx.db, ctx.orgId).doc("instagram_real2").set({ platform: "instagram", externalId: "real2", postId: "999", postLabel: "Real post", author: "@real", text: "real comment", at: 1, sample: false, status: "new" });
    await posts(ctx.db, ctx.orgId).doc("instagram_999").set({ platform: "instagram", postId: "999", label: "Real post", total: 1, sample: false });
    await addAllowedDomain(ctx, manager, { domain: "bank-two.com" });
    const before = (await org(ctx.db, ctx.orgId).get()).data()!.allowedDomains;

    await resetDemo(ctx, manager);

    expect((await comments(ctx.db, ctx.orgId).doc("instagram_real2").get()).exists).toBe(true);
    expect((await posts(ctx.db, ctx.orgId).doc("instagram_999").get()).exists).toBe(true);
    expect((await org(ctx.db, ctx.orgId).get()).data()!.allowedDomains).toEqual(before);
    expect((await org(ctx.db, ctx.orgId).collection("invites").doc("ex@partner.io").get()).exists).toBe(true);
    // and the sample set is back, exactly once
    expect((await comments(ctx.db, ctx.orgId).where("sample", "==", true).get()).size).toBe(27);
  });
});
