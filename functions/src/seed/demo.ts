import { conversations, customers, kb, messages, org, policyDoc, traces } from "../lib/paths";
import type { ConversationDoc, CustomerDoc, MessageDoc, TraceDoc } from "../lib/model";
import { DEFAULT_POLICY } from "../types";
import type { Ctx } from "../agent/context";
import { seedComments } from "./comments";

const C = (a: string, b: string): [string, string] => [a, b];

export const ORG_NAME = "Ravenwood Bank";
export const ALLOWED_DOMAINS = ["demo.com", "ravenwoodbank.com"];

type Seed = Omit<CustomerDoc, "phoneMasked" | "initials" | "sample"> & { id: string; phone: string };
const CUSTOMERS: Seed[] = [
  { id: "c1", name: "Marcus Reed", color: C("#FDECEC", "#B42E2E"), phone: "(415) •••-0142", tier: "Premier", since: 2019, city: "Oakland, CA", language: "en", csat: 4.6, churn: "Medium", segment: "cautious", traits: ["Brief", "Risk-averse", "Prefers voice"], summary: "Long-standing Premier customer. Brief and risk-averse; prefers voice messages." },
  { id: "c2", name: "Emily Chen", color: C("#E4E6FB", "#3D45B0"), phone: "(206) •••-7781", tier: "Everyday", since: 2021, city: "Seattle, WA", language: "en", csat: 4.9, churn: "Low", segment: "digital", traits: ["Detail-seeking", "Night owl", "Self-serve"], summary: "Digital-first customer who prefers instant answers. Sends money abroad a few times a year." },
  { id: "c3", name: "Robert Miller", color: C("#E9F7EF", "#17763F"), phone: "(602) •••-3310", tier: "Everyday", since: 2008, city: "Phoenix, AZ", language: "en", csat: 4.4, churn: "Low", segment: "cautious", traits: ["Retired", "Low digital comfort", "Taps buttons"], summary: "68-year-old long-time customer. Forwards suspicious texts to check them. Benefits from simple, step-by-step guidance." },
  { id: "c4", name: "Sarah Lopez", color: C("#FDF5E6", "#8A5A10"), phone: "(312) •••-9024", tier: "Premier", since: 2017, city: "Chicago, IL", language: "en", csat: 4.7, churn: "Low", segment: "busy", traits: ["Busy", "Short replies", "Prefers messaging"], summary: "School principal with a new phone number. Wants account changes done without visiting a branch." },
  { id: "c5", name: "Zoe Carter", color: C("#F3E8FF", "#6B3FA0"), phone: "(512) •••-5506", handle: "@zoecodes", tier: "Everyday", since: 2022, city: "Austin, TX", language: "en", csat: 3.9, churn: "High", segment: "digital", traits: ["Vocal on social", "App-first", "Impatient"], summary: "Posted publicly about the payday app outage." },
  { id: "c6", name: "Daniel Okafor", color: C("#E6F6F5", "#1F7A77"), phone: "(713) •••-2218", tier: "Premier", since: 2015, city: "Houston, TX", language: "en", csat: 4.8, churn: "Low", segment: "senders", traits: ["Sends money abroad", "Fee-sensitive", "Wants transparency"], summary: "Sends money to family in Lagos monthly. Responds well to transparent fee information." },
  { id: "c7", name: "Priya Shah", color: C("#EAF2FD", "#225FAB"), phone: "(908) •••-6612", tier: "Private", since: 2012, city: "Newark, NJ", language: "en", csat: 4.9, churn: "Low", segment: "status", traits: ["Premium-oriented", "Values recognition"], summary: "Private banking client, interested in the Metal card." },
  { id: "c8", name: "James Walker", color: C("#EFEFF1", "#3F3F46"), phone: "(404) •••-4470", tier: "Everyday", since: 2020, city: "Atlanta, GA", language: "en", csat: 3.2, churn: "High", segment: "dormant", traits: ["Low activity", "Recent complaint"], summary: "Low recent activity and a rising number of complaints. Good candidate for proactive outreach." },
  { id: "c9", name: "Ana Gutierrez", color: C("#FDECEC", "#B42E2E"), phone: "(305) •••-8813", tier: "Everyday", since: 2018, city: "Miami, FL", language: "es", csat: 4.5, churn: "Low", segment: "senders", traits: ["Bilingual", "Sends money abroad"], summary: "Prefers Spanish. Uses international wires to Colombia." },
  { id: "c10", name: "Tom Becker", color: C("#E9F7EF", "#17763F"), phone: "(720) •••-1190", tier: "Everyday", since: 2023, city: "Denver, CO", language: "en", csat: 4.2, churn: "Medium", segment: "digital", traits: ["Self-serve", "Brief"], summary: "New-ish customer who mostly uses the app." },
];

const KB_DOCS = [
  { id: "fee", title: "Fee Schedule", status: "active", sections: [
    { id: "§4.2", title: "International wires", text: "Outgoing international wires are $45 each. Wires sent before 4pm ET go out the same business day." },
    { id: "§4.1", title: "Domestic wires", text: "Outgoing domestic wires are $25. Incoming wires are free." },
    { id: "§2.3", title: "Card replacement", text: "Standard card replacement is free. Expedited delivery is $25." }] },
  { id: "fraud", title: "Fraud Playbook", status: "active", sections: [
    { id: "§2.1", title: "One-time code scams", text: "Ravenwood never asks for one-time codes. If a customer reports a code request, lock the card, reassure them, and escalate to Fraud within 10 minutes." },
    { id: "§3.1", title: "Phishing texts", text: "Our only domain is ravenwoodbank.com. Lookalike links are phishing. Ask whether details were entered; if yes, escalate as P1." }] },
  { id: "xfer", title: "International Transfers", status: "active", sections: [{ id: "§2.1", title: "Delivery times", text: "International wires usually arrive in 1 to 3 business days depending on the receiving bank." }] },
  { id: "acct", title: "Account Changes", status: "active", sections: [{ id: "§1.3", title: "Phone and address changes", text: "Identity changes require verification by a colleague by phone. Never change contact details by chat." }] },
  { id: "od", title: "Overdraft Policy", status: "active", sections: [{ id: "§3.2", title: "Fee refunds", text: "Overdraft fees are $30. Refunds are at a colleague's discretion; one courtesy refund per 12 months." }] },
  { id: "cards", title: "Cards", status: "active", sections: [
    { id: "§1.1", title: "Activation", text: "Activate a card in the app: Cards, then Activate. It takes about a minute." },
    { id: "§1.4", title: "Lost or stolen", text: "Lock the card in the app immediately; a replacement ships in 3 to 5 business days." }] },
  { id: "basics", title: "Account Basics", status: "active", sections: [
    { id: "§1.2", title: "Routing number", text: "Ravenwood Bank routing number (demo): 000-000-123." },
    { id: "§1.5", title: "Branch hours", text: "Branches are open 9am to 5pm Monday to Friday and 9am to 1pm Saturday." }] },
  { id: "faq-old", title: "Card Fees FAQ (2024)", status: "retired", sections: [{ id: "§1", title: "Old international wire fee", text: "International wires cost $35. Replaced by the 2026 Fee Schedule." }] },
];

/** A lived-in inbox: a few finished conversations with their reasoning traces. */
const HISTORY: { customer: string; channel: ConversationDoc["channel"]; status: ConversationDoc["status"]; decision: ConversationDoc["decision"]; intent: ConversationDoc["intent"]; ago: number; msgs: [("in" | "out"), "customer" | "ai", string, { cite?: { doc: string; section: string } }?][]; trace?: Partial<TraceDoc>; approval?: ConversationDoc["approval"] }[] = [
  { customer: "c7", channel: "instagram", status: "resolved", decision: "auto_resolved", intent: "fee_inquiry", ago: 8 * 60_000,
    msgs: [["in", "customer", "What's the fee for an international wire?"], ["out", "ai", "Outgoing international wires are $45 each. Wires sent before 4pm ET go out the same business day.", { cite: { doc: "Fee Schedule", section: "§4.2" } }]],
    trace: { intent: "fee_inquiry", confidence: 0.93, policyId: "P-01", policy: "Confidence 0.93 >= 0.85", action: "auto_send", summary: "Auto-sent · Fee Schedule §4.2", steps: [{ label: "Understood", detail: "intent fee_inquiry · neutral · en · Gemini" }, { label: "Retrieved", detail: "Fee Schedule §4.2 (score 0.93)" }, { label: "Decided", detail: "P-01: Confidence 0.93 >= 0.85", tone: "ok" }, { label: "Acted", detail: "reply sent" }] } },
  { customer: "c6", channel: "telegram", status: "resolved", decision: "auto_resolved", intent: "wire_timing", ago: 34 * 60_000,
    msgs: [["in", "customer", "How long does a wire to Nigeria take?"], ["out", "ai", "International wires usually arrive in 1 to 3 business days depending on the receiving bank.", { cite: { doc: "International Transfers", section: "§2.1" } }]],
    trace: { intent: "wire_timing", confidence: 0.9, policyId: "P-01", policy: "Confidence 0.90 >= 0.85", action: "auto_send", summary: "Auto-sent · International Transfers §2.1", steps: [{ label: "Understood", detail: "intent wire_timing · neutral · en · Gemini" }, { label: "Retrieved", detail: "International Transfers §2.1 (score 0.90)" }, { label: "Decided", detail: "P-01: Confidence 0.90 >= 0.85", tone: "ok" }, { label: "Acted", detail: "reply sent" }] } },
  { customer: "c8", channel: "x", status: "needs_human", decision: "needs_human", intent: "complaint", ago: 52 * 60_000,
    msgs: [["in", "customer", "This is the third time I've been charged an overdraft fee this month. I'm seriously thinking about closing my account."]],
    approval: { draft: "Hi James, I'm sorry about the repeated overdraft fees. I've reviewed your account and I'd like to look at what we can do. Would you like me to turn on low-balance alerts too?", reason: "Refund request", createdAt: 0 },
    trace: { intent: "complaint", sentiment: "angry", confidence: 0.85, policyId: "P-03", policy: "Complaints with churn risk need a human", action: "draft", summary: "Draft ready · P-03", steps: [{ label: "Understood", detail: "intent complaint · angry · en · Gemini" }, { label: "Retrieved", detail: "Overdraft Policy §3.2" }, { label: "Decided", detail: "P-03: Complaints with churn risk need a human", tone: "warn" }, { label: "Acted", detail: "draft queued for approval" }] } },
  { customer: "c10", channel: "instagram", status: "resolved", decision: "resolved", intent: "card_activation", ago: 2 * 3_600_000,
    msgs: [["in", "customer", "How do I activate my new card?"], ["out", "ai", "Activate a card in the app: Cards, then Activate. It takes about a minute.", { cite: { doc: "Cards", section: "§1.1" } }], ["in", "customer", "Done, thanks!"]] },
];

/**
 * Idempotent. Safe to run again to restore the demo state.
 * It only ever touches SAMPLE data. Real conversations, real comments, and who is allowed to sign in are left alone:
 * the organization document is written once, when it does not exist yet, and never overwritten afterwards.
 */
export async function seedDemoData(ctx: Ctx, opts: { allowedDomains?: string[] } = {}): Promise<{ customers: number; kb: number; conversations: number; comments: number }> {
  const batch = ctx.db.batch();
  const orgRef = org(ctx.db, ctx.orgId);
  if (!(await orgRef.get()).exists) {
    batch.set(orgRef, { name: ORG_NAME, allowedDomains: opts.allowedDomains ?? ALLOWED_DOMAINS, officialDomains: ["ravenwoodbank.com"], demoMode: true });
  }
  batch.set(policyDoc(ctx.db, ctx.orgId), { ...DEFAULT_POLICY, perIntent: { fee_inquiry: 0.85, wire_timing: 0.85 } });
  for (const { id, phone, ...rest } of CUSTOMERS) {
    const initials = rest.name.split(" ").map((p) => p[0]).join("");
    batch.set(customers(ctx.db, ctx.orgId).doc(id), { ...rest, initials, phoneMasked: phone, sample: true } satisfies CustomerDoc);
  }
  for (const { id, ...rest } of KB_DOCS) batch.set(kb(ctx.db, ctx.orgId).doc(id), rest);
  await batch.commit();

  const now = ctx.now();
  for (const h of HISTORY) {
    const convId = `${h.customer}_${h.channel}`;
    const lastAt = now - h.ago;
    const last = h.msgs[h.msgs.length - 1];
    const conv: ConversationDoc = {
      customerId: h.customer, channel: h.channel, transport: "sim", status: h.status, decision: h.decision, intent: h.intent, priority: 1, unread: h.status !== "resolved",
      thinking: false, mode: "agent", lastAt, lastPreview: last[2].slice(0, 120), lastKind: "text", lastCustomerMessageAt: lastAt, assignee: null, caseId: null,
      approval: h.approval ? { ...h.approval, createdAt: lastAt } : null, agentLease: null, sample: true, origin: "sample",
    };
    await conversations(ctx.db, ctx.orgId).doc(convId).set(conv);
    // Clear any previous messages and traces so re-seeding restores the exact state.
    for (const col of [messages(ctx.db, ctx.orgId, convId), traces(ctx.db, ctx.orgId, convId)]) {
      const old = await col.get();
      await Promise.all(old.docs.map((d) => d.ref.delete()));
    }
    let t = lastAt - 20_000 * h.msgs.length;
    let firstIn: string | null = null;
    for (const [dir, author, text, extra] of h.msgs) {
      t += 6000;
      const m: MessageDoc = { dir, author, kind: "text", text, at: t, status: dir === "out" ? "read" : "received", processed: true, ...(extra?.cite ? { cite: extra.cite } : {}) };
      const ref = await messages(ctx.db, ctx.orgId, convId).add(m);
      if (dir === "in" && !firstIn) firstIn = ref.id;
    }
    if (h.trace && firstIn) {
      await traces(ctx.db, ctx.orgId, convId).add({
        afterMsg: firstIn, intent: "unknown", sentiment: "neutral", language: "en", confidence: 0.9, policyId: "P-01", policy: "", action: "auto_send", summary: "", steps: [], tools: [], source: "gemini", latencyMs: 1400, at: lastAt, ...h.trace,
      } as TraceDoc);
    }
  }
  const c = await seedComments(ctx);
  return { customers: CUSTOMERS.length, kb: KB_DOCS.length, conversations: HISTORY.length, comments: c.comments };
}

