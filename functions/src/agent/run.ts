import { randomUUID } from "node:crypto";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { createAdkUnderstander } from "./adk/factory";
import type { AdkDeps } from "./adk/tools";
import { lockCard, openCase, raiseAlert, writeAudit } from "./ops";
import { bump, health } from "./metrics";
import { deliver, OutboundBlocked } from "./outbound";
import { composeReply, type Reply } from "./replies";
import { retrieveFromDocs, type KbDoc } from "./retrieve";
import { understand, type MediaPart, type UnderstandResult } from "./understand";
import type { Ctx } from "./context";
import { safeFirstName } from "../lib/text";
import { cards, conversations, customers, kb as kbCol, messages, org, policyDoc, traces } from "../lib/paths";
import type { AdkTraceDoc, ConversationDoc, CustomerDoc, DecisionLabel, ConvStatus, MessageDoc, TraceDoc } from "../lib/model";
import { decide, effectiveConfidence } from "../policy/engine";
import { checkDomain, extractDomains } from "../policy/domain";
import { DEFAULT_POLICY, type Decision, type Intent, type Policy, type Retrieval, type TraceStep, type Understanding } from "../types";
import { downloadMedia } from "../whatsapp/client";
import { downloadFile as downloadTelegramFile } from "../telegram/client";

const LEASE_MS = 120_000;
const RESOLVES_ON_ANSWER = new Set<Intent>(["fee_inquiry", "wire_timing", "knowledge_question", "card_activation", "phishing_safe"]);

// ── lease: one agent run per conversation at a time ────────────────────────────

async function acquireLease(ctx: Ctx, convId: string, owner: string): Promise<boolean> {
  const ref = conversations(ctx.db, ctx.orgId).doc(convId);
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const lease = (snap.data() as ConversationDoc).agentLease;
    if (lease && lease.until > ctx.now() && lease.owner !== owner) return false;
    tx.update(ref, { agentLease: { until: ctx.now() + LEASE_MS, owner } });
    return true;
  });
}

async function releaseLease(ctx: Ctx, convId: string, owner: string): Promise<void> {
  const ref = conversations(ctx.db, ctx.orgId).doc(convId);
  await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && (snap.data() as ConversationDoc).agentLease?.owner === owner) tx.update(ref, { agentLease: null });
  });
}

/** The buttons our latest message offered, if any. */
async function offeredButtons(ctx: Ctx, convId: string): Promise<string[]> {
  const snap = await messages(ctx.db, ctx.orgId, convId).orderBy("at", "desc").limit(6).get();
  for (const d of snap.docs) {
    const m = d.data() as MessageDoc;
    if (m.dir === "out" && m.author !== "system") return m.buttons ?? [];
  }
  return [];
}

/**
 * The customer's answer to buttons we offered, or undefined for an ordinary message.
 * A tap counts, and so does a short typed "yes" or "no". "Yes I did pay my bill on time" does not.
 */
export function answerToOffer(offered: string[], msg: Pick<MessageDoc, "text" | "viaButton">): string | undefined {
  if (!offered.length) return undefined;
  const t = msg.text.trim();
  if (msg.viaButton && offered.includes(t)) return t;
  if (t.length <= 25 && /^(yes|no)\b/i.test(t)) return t;
  return undefined;
}

/** The oldest customer message the agent has not handled yet. */
async function nextUnprocessed(ctx: Ctx, convId: string): Promise<DocumentSnapshot | null> {
  const recent = await messages(ctx.db, ctx.orgId, convId).orderBy("at", "desc").limit(25).get();
  const pending = recent.docs.filter((d) => {
    const m = d.data() as MessageDoc;
    return m.dir === "in" && m.processed === false;
  });
  return pending.length ? pending[pending.length - 1] : null;
}

/**
 * Entry point. Safe to call many times for the same conversation: the holder of the lease
 * drains every unhandled message in order, and a caller that cannot get the lease returns
 * because the holder will pick its message up.
 */
export async function processConversation(ctx: Ctx, convId: string): Promise<void> {
  const owner = randomUUID();
  for (let round = 0; round < 3; round++) {
    if (!(await acquireLease(ctx, convId, owner))) return;
    try {
      for (let n = 0; n < 10; n++) {
        const next = await nextUnprocessed(ctx, convId);
        if (!next) break;
        await handleMessage(ctx, convId, next);
      }
    } finally {
      await releaseLease(ctx, convId, owner);
    }
    // A message may have arrived between the last check and releasing the lease.
    if (!(await nextUnprocessed(ctx, convId))) return;
  }
}

// ── one message ────────────────────────────────────────────────────────────────

const decisionLabel = (d: Decision, u: Understanding): DecisionLabel => {
  switch (d.action) {
    case "safety_and_escalate": return "fraud_risk";
    case "auto_send": return u.intent === "phishing_check" ? "phishing" : "auto_resolved";
    case "draft": return "draft_ready";
    case "fallback": return u.intent === "fx_rate" ? "no_source" : "needs_human";
    default: return "human";
  }
};

const priorityFor = (i: Intent): number =>
  ({ otp_scam_report: 5, phishing_compromised: 5, fraud_report: 5, phishing_check: 4, complaint: 4, refund: 4, account_change: 3, card_lost: 3 } as Partial<Record<Intent, number>>)[i] ?? 1;

async function loadKb(ctx: Ctx): Promise<KbDoc[]> {
  const snap = await kbCol(ctx.db, ctx.orgId).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<KbDoc, "id">) }));
}

export async function loadPolicy(ctx: Ctx): Promise<Policy> {
  const snap = await policyDoc(ctx.db, ctx.orgId).get();
  return snap.exists ? { ...DEFAULT_POLICY, ...(snap.data() as Partial<Policy>) } : DEFAULT_POLICY;
}

async function handleMessage(ctx: Ctx, convId: string, msgSnap: DocumentSnapshot): Promise<void> {
  const started = ctx.now();
  const convRef = conversations(ctx.db, ctx.orgId).doc(convId);
  const msg = msgSnap.data() as MessageDoc;
  // A run that crashed after replying leaves the message unmarked. Its trace shows it was handled, so do not answer twice.
  const already = await traces(ctx.db, ctx.orgId, convId).where("afterMsg", "==", msgSnap.id).limit(1).get();
  if (!already.empty) {
    await msgSnap.ref.update({ processed: true });
    return;
  }
  try {
    await convRef.update({ thinking: true });
    await runAgent(ctx, convId, msgSnap.id, msg, started);
  } catch (e) {
    ctx.log("agent failed, handing over safely", { convId, error: (e as Error).message });
    await failSafe(ctx, convId, msgSnap.id, e as Error);
  } finally {
    await msgSnap.ref.update({ processed: true });
    await convRef.update({ thinking: false });
  }
}

async function runAgent(ctx: Ctx, convId: string, msgId: string, msg: MessageDoc, started: number): Promise<void> {
  const convRef = conversations(ctx.db, ctx.orgId).doc(convId);
  const conv = (await convRef.get()).data() as ConversationDoc;
  const customerSnap = await customers(ctx.db, ctx.orgId).doc(conv.customerId).get();
  const customer = { id: customerSnap.id, ...(customerSnap.data() as CustomerDoc) };
  const [policy, kbDocs, orgSnap] = await Promise.all([loadPolicy(ctx), loadKb(ctx), org(ctx.db, ctx.orgId).get()]);
  const officialDomains: string[] = (orgSnap.data()?.officialDomains as string[] | undefined) ?? ["ravenwoodbank.com"];
  const officialDomain = officialDomains[0];
  const firstName = safeFirstName(customer.name);
  const cardLocked = !!(await cards(ctx.db, ctx.orgId).doc(customer.id).get()).data()?.locked;

  // 1. A human is in control: stay silent.
  if (conv.mode === "human") {
    await convRef.update({ unread: true });
    return;
  }

  // 2. Media: fetch from WhatsApp, keep a copy in Storage, hand the bytes to the model.
  let media: MediaPart | undefined;
  const notes: string[] = [];
  const canFetch = conv.transport === "whatsapp" ? !!ctx.whatsapp : conv.transport === "telegram" ? !!ctx.telegram : false;
  if (msg.mediaId && canFetch) {
    try {
      const m = conv.transport === "telegram" && ctx.telegram
        ? await downloadTelegramFile(ctx.telegram, msg.mediaId, msg.mediaMime || "application/octet-stream")
        : await downloadMedia(ctx.whatsapp!.token, msg.mediaId);
      media = { mimeType: m.mimeType.split(";")[0], data: m.data };
      if (ctx.bucket) {
        const path = `orgs/${ctx.orgId}/media/${msgId}`;
        await ctx.bucket.file(path).save(m.data, { contentType: m.mimeType });
        await messages(ctx.db, ctx.orgId, convId).doc(msgId).update({ mediaPath: path });
      }
    } catch (e) {
      notes.push(`media unavailable (${(e as Error).message})`);
    }
  } else if (msg.mediaPath && ctx.bucket) {
    // A web chat upload is already in Cloud Storage.
    try {
      const [data] = await ctx.bucket.file(msg.mediaPath).download();
      media = { mimeType: (msg.mediaMime || "application/octet-stream").split(";")[0], data };
    } catch (e) {
      notes.push(`media unavailable (${(e as Error).message})`);
    }
  }

  // 3. Understand (Gemini via ADK when configured, always merged with the rule-based net).
  const deps: AdkDeps = {
    officialDomains,
    searchPolicy: async (q) => retrieveFromDocs(q, kbDocs),
    customerContext: async () => ({ tier: customer.tier, customerSinceYear: customer.since, recentIntents: conv.intent === "…" ? [] : [conv.intent], cardLocked }),
  };
  const adk = ctx.understanderOverride !== undefined ? ctx.understanderOverride : createAdkUnderstander(ctx.adk, deps);
  const buttonReply = msg.kind === "text" ? answerToOffer(await offeredButtons(ctx, convId), msg) : undefined;
  const result: UnderstandResult = await understand(adk, { text: msg.text, kind: msg.kind, imageText: msg.imageText, media, buttonReply, officialDomains });
  const u = result.understanding;
  const text = u.transcript || msg.text;

  // 4. Check every domain in the message.
  const domains = Array.from(new Set([...u.urls.map((x) => x.toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0]), ...extractDomains(`${msg.text} ${msg.imageText ?? ""} ${u.transcript ?? ""}`)])).filter(Boolean);
  const verdicts = domains.map((d) => checkDomain(d, officialDomains));
  const lookalikes = verdicts.filter((v) => v.verdict === "lookalike").map((v) => v.domain);

  // 5. Retrieve approved knowledge when the intent needs a source.
  const retrieval: Retrieval | null = retrieveFromDocs(text, kbDocs);

  // 6. Decide. Deterministic code, not the model.
  const decision = decide({ understanding: u, retrieval, policy, mode: conv.mode });
  const reply = composeReply({ firstName, officialDomain, decision, understanding: u, retrieval, lookalikes });

  // 7. Act.
  const acted: string[] = [];
  const tools: string[] = result.toolCalls.map((t) => t.name);
  let caseId = conv.caseId ?? null;
  let casesOpened = 0, cardsLocked = 0;
  let approval: ConversationDoc["approval"] = conv.approval ?? null;
  let deliveredText: string | null = null;
  const actor = "agent";

  if (decision.action === "safety_and_escalate") {
    await lockCard(ctx, customer.id, `Fraud policy ${decision.policyId}: ${u.intent}`);
    cardsLocked++;
    acted.push("lock_card()");
    tools.push("lock_card");
    if (!caseId) {
      caseId = await openCase(ctx, customer.id, convId, u.intent === "phishing_compromised" ? "P1" : "P2", `${u.intent} reported by ${customer.name}`);
      casesOpened++;
      acted.push(`create_case() → ${caseId}`);
      tools.push("create_case");
    }
    await writeAudit(ctx, actor, "tool", `lock_card(${customer.name})${caseId ? ` · ${caseId}` : ""}`, "ok");
    await raiseAlert(ctx, "err", u.intent === "phishing_compromised" ? "P1 fraud case opened" : "Fraud team notified", `${customer.name} · ${u.intent.replace(/_/g, " ")}${caseId ? ` · ${caseId}` : ""}`);
  } else if (u.intent === "card_lost" && decision.action === "auto_send") {
    await lockCard(ctx, customer.id, "Customer reported card lost");
    cardsLocked++;
    acted.push("lock_card()");
    tools.push("lock_card");
    await writeAudit(ctx, actor, "tool", `lock_card(${customer.name})`, "ok");
  } else if (decision.policyId === "P-05") {
    await raiseAlert(ctx, "info", "Possible fraud signal needs review", `${customer.name} · nothing locked until a person confirms`);
  } else if (u.intent === "phishing_check" && lookalikes.length) {
    await raiseAlert(ctx, "info", "Phishing detected", `Lookalike domain from ${customer.name}`);
  }

  const sendReply = !!reply && (decision.action === "auto_send" || decision.action === "safety_and_escalate" || decision.holdingReply);
  if (reply && sendReply) {
    try {
      await sendOne(ctx, convId, conv, customer, reply, lookalikes);
      deliveredText = reply.text;
      acted.push("reply sent");
    } catch (e) {
      if (e instanceof OutboundBlocked) acted.push(`reply blocked (${e.reason})`);
      else throw e;
    }
  }

  if (reply?.approvalDraft && (decision.action === "draft" || decision.action === "fallback")) {
    approval = { draft: reply.approvalDraft, reason: reply.approvalReason ?? decision.reason, createdAt: ctx.now() };
    acted.push("draft queued for approval");
    tools.push("create_approval");
  }

  // 8. Trace.
  const confidence = effectiveConfidence(u, decision.action === "safety_and_escalate" ? null : retrieval);
  const steps: TraceStep[] = [
    { label: "Understood", detail: `${msg.kind === "voice" ? "voice message transcribed · " : msg.kind === "image" ? "image read · " : ""}intent ${u.intent} · ${u.sentiment} · ${u.language}${u.source === "gemini" ? " · Gemini" : " · rules"}${result.modelError ? ` (model unavailable: ${result.modelError})` : ""}` },
  ];
  if (verdicts.length || result.toolCalls.length) {
    const bits = verdicts.map((v) => `${v.domain} → ${v.verdict}`);
    for (const t of result.toolCalls.filter((x) => x.name !== "check_domain")) bits.push(`${t.name}()`);
    steps.push({ label: "Checked", detail: bits.join(" · "), tone: lookalikes.length ? "warn" : "ok" });
  }
  if (retrieval && retrieval.score >= policy.draft && !["fraud_report", "otp_scam_report", "phishing_compromised"].includes(u.intent)) {
    steps.push({ label: "Retrieved", detail: `${retrieval.doc} ${retrieval.section} (score ${retrieval.score.toFixed(2)})` });
  } else if (decision.policyId === "P-02") {
    steps.push({ label: "Retrieved", detail: "No approved source above the minimum score", tone: "warn" });
  } else if (reply?.cite) {
    steps.push({ label: "Retrieved", detail: `${reply.cite.doc} ${reply.cite.section}` });
  }
  steps.push({ label: "Decided", detail: `${decision.policyId}: ${decision.reason}`, tone: decision.requiresHuman ? "warn" : "ok" });
  steps.push({ label: "Acted", detail: acted.length ? acted.join(" · ") : "no outbound action" });
  for (const n of notes) steps.push({ label: "Checked", detail: n, tone: "warn" });

  const trace: TraceDoc = {
    afterMsg: msgId, intent: u.intent, sentiment: u.sentiment, language: u.language, confidence: +confidence.toFixed(2),
    policyId: decision.policyId, policy: decision.reason, action: decision.action,
    summary: decision.action === "safety_and_escalate" ? `Escalated to Fraud · policy ${decision.policyId}` : decision.action === "auto_send" ? `Auto-sent · ${reply?.cite ? `${reply.cite.doc} ${reply.cite.section}` : decision.policyId}` : decision.action === "draft" ? `Draft ready · ${decision.policyId}` : `Needs human · ${decision.policyId}`,
    steps, tools: Array.from(new Set(tools)), source: u.source, latencyMs: ctx.now() - started, at: ctx.now(),
    adk: adkTrace(ctx, result),
  };
  await traces(ctx.db, ctx.orgId, convId).add(trace);

  // 9. Conversation state.
  const label = decisionLabel(decision, u);
  const status: ConvStatus =
    decision.action === "safety_and_escalate" ? "fraud"
      : approval && (decision.action === "draft" || decision.action === "fallback") ? "needs_human"
        : decision.action === "auto_send" && RESOLVES_ON_ANSWER.has(u.intent) ? "resolved"
          : "open";
  await convRef.update({
    decision: label, status, intent: u.intent, priority: priorityFor(u.intent), unread: true, caseId, approval,
    ...(deliveredText ? { lastPreview: deliveredText.slice(0, 120), lastAt: ctx.now() } : {}),
  });
  if (u.transcript) await messages(ctx.db, ctx.orgId, convId).doc(msgId).update({ transcript: u.transcript });
  // 10. Operating numbers for the Agent dashboard.
  await bump(ctx, {
    runs: 1,
    [conv.transport === "sim" ? "runsSimulated" : "runsLive"]: 1,
    [`action.${decision.action}`]: 1,
    [`policy.${decision.policyId}`]: 1,
    [u.source === "gemini" ? "understoodByGemini" : "understoodByRules"]: 1,
    modelErrors: result.modelError ? 1 : 0,
    rulesOverrodeModel: result.modelReading && result.modelReading.intent !== u.intent ? 1 : 0,
    latencyMsSum: trace.latencyMs,
    understandMsSum: result.ms,
    repliesSent: deliveredText ? 1 : 0,
    firstReplyMsSum: deliveredText ? Math.max(0, ctx.now() - msg.at) : 0,
    draftsQueued: approval && approval !== conv.approval ? 1 : 0,
    casesOpened,
    cardsLocked,
    mediaRead: media ? 1 : 0,
  });
  await health(ctx, "customer-agent", result.modelError
    ? { ok: false, error: `Gemini unavailable, rules used instead: ${result.modelError}` }
    : { ok: true, detail: `${u.source === "gemini" ? (ctx.adk?.model ?? "Gemini") : "rules only"} · ${u.intent} · ${(result.ms / 1000).toFixed(1)}s` });
  await health(ctx, "policy-engine", { ok: true, detail: `${decision.policyId}: ${decision.reason}` });

  await writeAudit(ctx, actor, decision.action === "safety_and_escalate" ? "escalate" : decision.action === "auto_send" ? "auto-send" : decision.action === "draft" ? "draft" : "fallback", `${u.intent} · ${trace.summary}`, confidence.toFixed(2));
}

const cap = (v: unknown, n = 700) => {
  let t: string;
  try { t = typeof v === "string" ? v : JSON.stringify(v ?? null); } catch { t = String(v); }
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const reading = (u: { intent: string; sentiment: string; confidence: number }) => ({ intent: u.intent, sentiment: u.sentiment, confidence: +u.confidence.toFixed(2) });

/** Condenses what the ADK pipeline did into a small, bounded document for the Agent Console. */
function adkTrace(ctx: Ctx, r: UnderstandResult): AdkTraceDoc {
  return {
    model: ctx.adk && r.modelReading ? ctx.adk.model : ctx.adk && r.modelError ? `${ctx.adk.model} (failed)` : "rules-only",
    agents: !ctx.adk ? [] : r.mode === "fast" ? ["classifier (fast path: checks run by code)"] : ["investigator", "classifier"],
    toolCalls: r.toolCalls.map((t) => ({ name: t.name, args: cap(t.args), result: cap(t.result) })),
    modelReading: r.modelReading ? reading(r.modelReading) : null,
    rulesReading: reading(r.rulesReading),
    overridden: !!r.modelReading && r.modelReading.intent !== r.understanding.intent,
    modelError: r.modelError ? cap(r.modelError, 200) : null,
    understandMs: r.ms,
  };
}

async function sendOne(ctx: Ctx, convId: string, conv: ConversationDoc, customer: CustomerDoc & { id: string }, reply: Reply, warnsAbout: string[]): Promise<void> {
  await deliver(ctx, { convId, conv, customer, text: reply.text, buttons: reply.buttons, cite: reply.cite, author: "ai", warnsAbout });
}

/** If anything in the pipeline throws, never go silent and never guess: hand over to a human. */
async function failSafe(ctx: Ctx, convId: string, msgId: string, error: Error): Promise<void> {
  const convRef = conversations(ctx.db, ctx.orgId).doc(convId);
  try {
    const conv = (await convRef.get()).data() as ConversationDoc;
    const customerSnap = await customers(ctx.db, ctx.orgId).doc(conv.customerId).get();
    const customer = { id: customerSnap.id, ...(customerSnap.data() as CustomerDoc) };
    try {
      await deliver(ctx, { convId, conv, customer, text: "I want to get this right, so I've asked a colleague to help. They'll reply here shortly.", author: "ai" });
    } catch {
      // window closed or blocked: the human queue still gets the case
    }
    await convRef.update({
      decision: "needs_human", status: "needs_human", priority: 3, unread: true,
      approval: { draft: `Hi ${safeFirstName(customer.name)}, thanks for your patience. `, reason: "Agent error: handled manually", createdAt: ctx.now() },
    });
    await traces(ctx.db, ctx.orgId, convId).add({
      afterMsg: msgId, intent: "unknown", sentiment: "neutral", language: "en", confidence: 0, policyId: "P-99", policy: "Agent error: safe handoff", action: "fallback",
      summary: "Needs human · agent error", steps: [{ label: "Decided", detail: `P-99: ${error.message.slice(0, 160)}`, tone: "warn" }, { label: "Acted", detail: "holding reply sent, case queued for a human" }],
      tools: [], source: "heuristic", latencyMs: 0, at: ctx.now(),
    } satisfies TraceDoc);
    await writeAudit(ctx, "agent", "error", `Safe handoff after error: ${error.message.slice(0, 160)}`, "P-99");
    await bump(ctx, { runs: 1, agentErrors: 1, "policy.P-99": 1 });
    await health(ctx, "customer-agent", { ok: false, error: `Run failed, handed to a person: ${error.message}` });
  } catch (inner) {
    ctx.log("failSafe also failed", { error: (inner as Error).message });
  }
}
