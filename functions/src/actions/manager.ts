import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import type { Ctx } from "../agent/context";
import { lockCard, officialDomainsOf, openCase, writeAudit } from "../agent/ops";
import { bump } from "../agent/metrics";
import { deliver } from "../agent/outbound";
import { loadPolicy } from "../agent/run";
import { evaluateAccess, validateAllowedDomain, type OrgAccess } from "../auth/authorize";
import { recordInbound } from "../ingest/record";
import {
  cards,
  comments,
  conversations,
  customers,
  kb,
  messages,
  org,
  policyDoc,
  posts,
} from "../lib/paths";
import {
  ingestComment,
  type CommentDoc,
  type CommentPlatform,
} from "../comments/ingest";
import { postCommentReply, setCommentHidden } from "../comments/meta";
import { checkOutbound } from "../policy/guards";
import type { ConversationDoc, CustomerDoc } from "../lib/model";
import { seedDemoData } from "../seed/demo";
import type { Channel, Policy } from "../types";

/** Thrown for problems the caller can fix. The callable layer maps these to HttpsError. */
export class ActionError extends Error {
  constructor(
    readonly code:
      | "not-found"
      | "failed-precondition"
      | "invalid-argument"
      | "permission-denied",
    message: string,
  ) {
    super(message);
  }
}

export interface Actor {
  uid: string;
  name: string;
  email: string;
  /** Absent means manager. A judge may only act on simulated conversations and sample comments. */
  role?: "manager" | "judge";
}

async function loadConv(ctx: Ctx, convId: string, actor?: Actor) {
  const ref = conversations(ctx.db, ctx.orgId).doc(convId);
  const snap = await ref.get();
  if (!snap.exists)
    throw new ActionError("not-found", "Conversation not found");
  const conv = snap.data() as ConversationDoc;
  // A judge may act on simulated conversations and on the public Telegram demo bot's chats, where they and
  // other testers are the "customers". WhatsApp reaches real phone numbers, so it stays a manager's.
  if (actor?.role === "judge" && conv.transport !== "sim" && conv.transport !== "telegram")
    throw new ActionError(
      "permission-denied",
      "Judges can act on simulated and Telegram demo conversations, not on WhatsApp ones",
    );
  const cs = await customers(ctx.db, ctx.orgId).doc(conv.customerId).get();
  if (!cs.exists) throw new ActionError("not-found", "Customer not found");
  return { ref, conv, customer: { id: cs.id, ...(cs.data() as CustomerDoc) } };
}

const nonEmpty = (s: string) => s.trim().length > 0;

export async function approveDraft(
  ctx: Ctx,
  actor: Actor,
  a: { convId: string; text?: string },
) {
  const { ref, conv, customer } = await loadConv(ctx, a.convId, actor);
  const noDraft = new ActionError(
    "failed-precondition",
    "There is no draft waiting for approval (someone may have just handled it)",
  );
  if (!conv.approval) throw noDraft;
  const text = (a.text ?? conv.approval.draft).trim();
  if (!nonEmpty(text))
    throw new ActionError("invalid-argument", "The reply is empty");
  const edited =
    a.text !== undefined && a.text.trim() !== conv.approval.draft.trim();

  // Claim the draft first, in a transaction, so two managers approving at once cannot both send it.
  const claimed = await ctx.db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data() as ConversationDoc | undefined;
    if (!fresh?.approval) return null;
    tx.update(ref, { approval: null });
    return fresh.approval;
  });
  if (!claimed) throw noDraft;

  try {
    await deliver(ctx, {
      convId: a.convId,
      conv: { ...conv, approval: null },
      customer,
      text,
      author: "human",
      authorName: actor.name,
    });
  } catch (e) {
    // Blocked or failed: the draft goes back to the queue so nothing is lost.
    await ref.update({ approval: claimed });
    throw e;
  }
  await ref.update({ decision: "human", status: "open", unread: false });
  await bump(ctx, { draftsApproved: 1 });
  await writeAudit(
    ctx,
    actor.email,
    "approved",
    `${conv.intent} · ${claimed.reason}${edited ? " · edited" : ""}`,
    "human",
  );
}

export async function rejectDraft(
  ctx: Ctx,
  actor: Actor,
  a: { convId: string; reason?: string },
) {
  const { ref, conv } = await loadConv(ctx, a.convId, actor);
  if (!conv.approval)
    throw new ActionError("failed-precondition", "There is no draft to reject");
  await ref.update({
    approval: null,
    mode: "human",
    assignee: actor.name,
    decision: "human",
  });
  await writeAudit(
    ctx,
    actor.email,
    "rejected",
    `${conv.intent} draft · ${a.reason ?? "rejected"}`,
    "human",
  );
}

export async function sendHuman(
  ctx: Ctx,
  actor: Actor,
  a: { convId: string; text: string },
) {
  const { ref, conv, customer } = await loadConv(ctx, a.convId, actor);
  const text = a.text.trim();
  if (!nonEmpty(text))
    throw new ActionError("invalid-argument", "The message is empty");
  await deliver(ctx, {
    convId: a.convId,
    conv,
    customer,
    text,
    author: "human",
    authorName: actor.name,
  });
  await ref.update({
    unread: false,
    ...(conv.approval ? { approval: null, decision: "human" } : {}),
  });
}

export async function setMode(
  ctx: Ctx,
  actor: Actor,
  a: { convId: string; human: boolean },
) {
  const { ref, conv } = await loadConv(ctx, a.convId, actor);
  await ref.update({
    mode: a.human ? "human" : "agent",
    assignee: a.human ? actor.name : null,
  });
  await bump(ctx, { [a.human ? "takeOvers" : "handBacks"]: 1 });
  await messages(ctx.db, ctx.orgId, a.convId).add({
    dir: "out",
    author: "system",
    kind: "text",
    at: ctx.now(),
    status: "delivered",
    processed: true,
    text: a.human
      ? `${actor.name} took over · agent paused`
      : "Handed back to the agent",
  });
  await writeAudit(
    ctx,
    actor.email,
    a.human ? "take-over" : "hand-back",
    `${conv.intent} conversation`,
    "human",
  );
}

export async function resolveConversation(
  ctx: Ctx,
  actor: Actor,
  a: { convId: string },
) {
  const { ref, conv } = await loadConv(ctx, a.convId, actor);
  await ref.update({
    status: "resolved",
    decision: conv.decision === "fraud_risk" ? "fraud_risk" : "resolved",
    unread: false,
    mode: "agent",
    assignee: null,
  });
  await writeAudit(
    ctx,
    actor.email,
    "resolved",
    `conversation ${a.convId}`,
    "human",
  );
}

export async function escalateToFraud(
  ctx: Ctx,
  actor: Actor,
  a: { convId: string },
) {
  const { ref, conv, customer } = await loadConv(ctx, a.convId, actor);
  const caseId =
    conv.caseId ??
    (await openCase(
      ctx,
      customer.id,
      a.convId,
      "P2",
      `Escalated by ${actor.name}`,
    ));
  // Same safety action the agent takes on its own fraud path: the card is locked until a person unlocks it.
  await lockCard(ctx, customer.id, `Escalated to Fraud by ${actor.name}`);
  await ref.update({
    status: "fraud",
    decision: "fraud_risk",
    priority: 5,
    caseId,
  });
  await writeAudit(
    ctx,
    actor.email,
    "escalate",
    `conversation ${a.convId} → Fraud · ${caseId} · card locked`,
    "human",
  );
  return { caseId };
}

/** Lifts a card lock. Only a person can do this; the agent never unlocks a card. */
export async function unlockCard(
  ctx: Ctx,
  actor: Actor,
  a: { convId: string },
) {
  const { conv, customer } = await loadConv(ctx, a.convId, actor);
  const ref = cards(ctx.db, ctx.orgId).doc(customer.id);
  if (!(await ref.get()).data()?.locked)
    throw new ActionError("failed-precondition", "This card is not locked");
  await ref.set(
    { locked: false, unlockedAt: ctx.now(), unlockedBy: actor.email },
    { merge: true },
  );
  await bump(ctx, { cardsUnlocked: 1 });
  await messages(ctx.db, ctx.orgId, a.convId).add({
    dir: "out",
    author: "system",
    kind: "text",
    at: ctx.now(),
    status: "delivered",
    processed: true,
    text: `${actor.name} unlocked the card`,
  });
  await writeAudit(
    ctx,
    actor.email,
    "unlock-card",
    `${customer.name} · ${conv.intent}`,
    "human",
  );
}

// ── policy and knowledge ───────────────────────────────────────────────────────

const PolicyPatch = z.object({
  autoSend: z.number().min(0.6).max(0.99).optional(),
  draft: z.number().min(0.4).max(0.95).optional(),
  perIntent: z.record(z.string(), z.number().min(0.6).max(0.99)).optional(),
  alwaysHuman: z.array(z.string().min(1).max(40)).max(20).optional(),
});

/** Intents that compliance has locked as always-human. They cannot be turned off here. */
export const LOCKED_ALWAYS_HUMAN = ["account_change"];

export async function updatePolicy(ctx: Ctx, actor: Actor, patch: unknown) {
  const parsed = PolicyPatch.safeParse(patch);
  if (!parsed.success)
    throw new ActionError(
      "invalid-argument",
      parsed.error.issues[0]?.message ?? "Invalid policy",
    );
  const before = await loadPolicy(ctx);
  const next: Policy = {
    ...before,
    ...parsed.data,
    perIntent: { ...before.perIntent, ...(parsed.data.perIntent ?? {}) },
  };
  if (next.draft >= next.autoSend)
    throw new ActionError(
      "invalid-argument",
      "The draft threshold must be lower than the auto-send threshold",
    );
  for (const locked of LOCKED_ALWAYS_HUMAN) {
    if (!next.alwaysHuman.includes(locked))
      throw new ActionError(
        "permission-denied",
        `${locked} is locked as always-human by compliance`,
      );
  }
  await policyDoc(ctx.db, ctx.orgId).set(next);
  const diffs: string[] = [];
  if (before.autoSend !== next.autoSend)
    diffs.push(`autoSend ${before.autoSend} → ${next.autoSend}`);
  if (before.draft !== next.draft)
    diffs.push(`draft ${before.draft} → ${next.draft}`);
  for (const [k, v] of Object.entries(next.perIntent))
    if (before.perIntent[k] !== v)
      diffs.push(`${k} ${before.perIntent[k] ?? before.autoSend} → ${v}`);
  if (before.alwaysHuman.join() !== next.alwaysHuman.join())
    diffs.push(`alwaysHuman [${before.alwaysHuman}] → [${next.alwaysHuman}]`);
  await writeAudit(
    ctx,
    actor.email,
    "policy",
    diffs.join("; ") || "no change",
    "human",
  );
  return next;
}

export async function addKbDoc(
  ctx: Ctx,
  actor: Actor,
  a: { title: string; text: string },
) {
  const title = a.title.trim(),
    text = a.text.trim();
  if (title.length < 3 || title.length > 120)
    throw new ActionError(
      "invalid-argument",
      "Title must be 3 to 120 characters",
    );
  if (text.length < 10 || text.length > 5000)
    throw new ActionError(
      "invalid-argument",
      "Content must be 10 to 5000 characters",
    );
  const ref = await kb(ctx.db, ctx.orgId).add({
    title,
    status: "active",
    updated: ctx.now(),
    sections: [{ id: "§1", title, text }],
  });
  await writeAudit(ctx, actor.email, "knowledge", `${title} added`, "human");
  return { id: ref.id };
}

export async function setKbStatus(
  ctx: Ctx,
  actor: Actor,
  a: { docId: string; status: "active" | "retired" },
) {
  const ref = kb(ctx.db, ctx.orgId).doc(a.docId);
  const snap = await ref.get();
  if (!snap.exists) throw new ActionError("not-found", "Document not found");
  await ref.update({ status: a.status, updated: ctx.now() });
  await writeAudit(
    ctx,
    actor.email,
    "knowledge",
    `${snap.data()?.title} → ${a.status}`,
    "human",
  );
}

// ── access: approved domains and invites ───────────────────────────────────────

export async function addAllowedDomain(
  ctx: Ctx,
  actor: Actor,
  a: { domain: string },
) {
  const v = validateAllowedDomain(a.domain);
  if (!v.ok) throw new ActionError("invalid-argument", v.error);
  await org(ctx.db, ctx.orgId).update({
    allowedDomains: FieldValue.arrayUnion(v.domain),
  });
  await writeAudit(
    ctx,
    actor.email,
    "access",
    `approved domain ${v.domain}`,
    "human",
  );
}

export async function removeAllowedDomain(
  ctx: Ctx,
  actor: Actor,
  a: { domain: string },
) {
  const snap = await org(ctx.db, ctx.orgId).get();
  const domains = (snap.data()?.allowedDomains as string[] | undefined) ?? [];
  const d = a.domain.trim().toLowerCase();
  const myDomain = actor.email.split("@")[1]?.toLowerCase();
  if (d === myDomain && domains.length === 1)
    throw new ActionError(
      "failed-precondition",
      "You cannot remove the last approved domain: you would lock yourself out",
    );
  await org(ctx.db, ctx.orgId).update({
    allowedDomains: FieldValue.arrayRemove(d),
  });
  const ended = await endAccessWhereNoLongerApproved(ctx, {
    uids: (await ctx.accounts?.uidsByDomain(d)) ?? [],
    emailDomain: d,
  });
  await writeAudit(
    ctx,
    actor.email,
    "access",
    `removed domain ${d}${ended ? ` · ${ended} session${ended === 1 ? "" : "s"} ended` : ""}`,
    "human",
  );
}

export async function addInvite(
  ctx: Ctx,
  actor: Actor,
  a: { email: string; role?: "manager" | "judge" },
) {
  const email = a.email.trim().toLowerCase();
  const check = evaluateAccess(email, true, {
    allowedDomains: [],
    invites: [email],
  });
  if (!check.allowed)
    throw new ActionError(
      "invalid-argument",
      "That does not look like an email address",
    );
  const role = a.role ?? "manager";
  await org(ctx.db, ctx.orgId)
    .collection("invites")
    .doc(email)
    .set({ by: actor.email, at: ctx.now(), role });
  await writeAudit(
    ctx,
    actor.email,
    "access",
    `invited ${email} as ${role}`,
    "human",
  );
}

export async function removeInvite(
  ctx: Ctx,
  actor: Actor,
  a: { email: string },
) {
  const email = a.email.trim().toLowerCase();
  if (email === actor.email.toLowerCase())
    throw new ActionError(
      "failed-precondition",
      "You cannot remove your own invite: you would lock yourself out",
    );
  await org(ctx.db, ctx.orgId).collection("invites").doc(email).delete();
  const uid = await ctx.accounts?.uidByEmail(email);
  const ended = await endAccessWhereNoLongerApproved(ctx, {
    uids: uid ? [uid] : [],
    email,
  });
  await writeAudit(
    ctx,
    actor.email,
    "access",
    `removed invite ${email}${ended ? " · session ended" : ""}`,
    "human",
  );
}

/** Everything that decides who may sign in, as it stands now. */
async function currentAccess(ctx: Ctx): Promise<OrgAccess> {
  const snap = await org(ctx.db, ctx.orgId).get();
  const invites = await org(ctx.db, ctx.orgId).collection("invites").get();
  return {
    allowedDomains: (snap.data()?.allowedDomains as string[] | undefined) ?? [],
    invites: invites.docs.map((d) => d.id),
    judges: invites.docs.filter((d) => d.data().role === "judge").map((d) => d.id),
  };
}

/**
 * After a domain or invite is removed, end the sessions of the people who are no longer approved.
 * Without this a removed person would keep manager rights until their token expired, or for good if the
 * claims were set directly on the account. People still covered by another domain or invite are left alone.
 * Returns how many accounts were ended.
 */
async function endAccessWhereNoLongerApproved(
  ctx: Ctx,
  from: { uids: string[]; email?: string; emailDomain?: string },
): Promise<number> {
  const access = await currentAccess(ctx);
  const members = await org(ctx.db, ctx.orgId).collection("members").get();
  const targets = new Map<string, string>(); // uid -> email
  for (const m of members.docs) {
    const email = String(m.data().email ?? "").toLowerCase();
    if ((from.email && email === from.email) || (from.emailDomain && email.endsWith(`@${from.emailDomain}`))) targets.set(m.id, email);
  }
  for (const uid of from.uids) if (!targets.has(uid)) targets.set(uid, from.email ?? "");
  let ended = 0;
  for (const [uid, known] of targets) {
    const email = known || String((await org(ctx.db, ctx.orgId).collection("members").doc(uid).get()).data()?.email ?? "");
    if (email && evaluateAccess(email, true, access).allowed) continue;
    // The member record is checked by the rules and by every callable, so access stops now, not when the token expires.
    await org(ctx.db, ctx.orgId).collection("members").doc(uid).set({ revoked: true, revokedAt: ctx.now() }, { merge: true });
    await ctx.accounts?.revoke(uid);
    ended++;
  }
  return ended;
}

// ── demo mode ──────────────────────────────────────────────────────────────────

async function requireDemo(ctx: Ctx) {
  const snap = await org(ctx.db, ctx.orgId).get();
  if (!snap.data()?.demoMode)
    throw new ActionError(
      "failed-precondition",
      "Demo tools are disabled for this organization",
    );
}

/** Files a judge may upload in the web chat: screenshots and voice notes. */
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav"] as const;
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

const SimInput = z.object({
  /** A sample customer's id, or "me" for the signed-in person's own private web-chat customer. */
  customerId: z.string().min(1).max(80),
  channel: z.enum([
    "whatsapp",
    "instagram",
    "facebook",
    "x",
    "tiktok",
    "telegram",
    "webchat",
  ]),
  /** A screenshot or voice note from the web chat, base64. */
  media: z.object({ mimeType: z.enum(MEDIA_TYPES), data: z.string().min(1).max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8) }).optional(),
  text: z.string().max(4000).default(""),
  kind: z.enum(["text", "voice", "image"]).default("text"),
  voiceSecs: z.number().int().min(1).max(600).optional(),
  imageText: z.string().max(2000).optional(),
  /** Simulates tapping one of the agent's reply buttons. */
  viaButton: z.boolean().optional(),
});

/** Feeds the same ingestion path as the real webhook, so a demo exercises the real pipeline. */
/**
 * Each person gets a private web-chat customer, so a judge testing the agent sees only their own conversation,
 * not a shared sample one. It is a sample customer, so the demo rules apply and it never reaches a real channel.
 */
async function sandboxCustomer(ctx: Ctx, actor: Actor): Promise<string> {
  const id = `sim_${actor.uid}`.slice(0, 80);
  const ref = customers(ctx.db, ctx.orgId).doc(id);
  if (!(await ref.get()).exists) {
    const first = (actor.name.split(/[\s@]/)[0] || "You").slice(0, 30);
    const doc: CustomerDoc = {
      name: `${first} (web chat)`, initials: first.slice(0, 2).toUpperCase(), color: ["#E4E6FB", "#3D45B0"], phoneMasked: "Web chat",
      tier: "Everyday", since: new Date(ctx.now()).getFullYear(), city: "", language: "en", csat: 0, churn: "Low", segment: "sandbox",
      traits: [], summary: `Private web-chat sandbox for ${actor.email}.`, sample: true,
    };
    await ref.set(doc);
  }
  return id;
}

/** Clears the signed-in person's own web-chat sandbox: its messages, reasoning, card lock and case link. Nothing else. */
export async function clearSandbox(ctx: Ctx, actor: Actor) {
  await requireDemo(ctx);
  const customerId = `sim_${actor.uid}`.slice(0, 80);
  const convRef = conversations(ctx.db, ctx.orgId).doc(`${customerId}_webchat`);
  for (const col of [convRef.collection("messages"), convRef.collection("traces")]) {
    const docs = await col.get();
    await Promise.all(docs.docs.map((d) => d.ref.delete()));
  }
  await convRef.delete();
  await cards(ctx.db, ctx.orgId).doc(customerId).delete();
  await writeAudit(ctx, actor.email, "demo", "cleared their web-chat sandbox", "human");
}

export async function simulateInbound(ctx: Ctx, actor: Actor, input: unknown) {
  await requireDemo(ctx);
  const parsed = SimInput.safeParse(input);
  if (!parsed.success)
    throw new ActionError(
      "invalid-argument",
      parsed.error.issues[0]?.message ?? "Invalid message",
    );
  const i = { ...parsed.data };
  if (i.customerId === "me") i.customerId = await sandboxCustomer(ctx, actor);

  // A screenshot or voice note: kept in Cloud Storage, read by Gemini from there.
  let mediaPath: string | undefined;
  if (i.media) {
    if (!ctx.bucket)
      throw new ActionError(
        "failed-precondition",
        "Uploads need Cloud Storage, which is not switched on for this project yet. Send a screenshot or voice note to the Telegram bot instead.",
      );
    const bytes = Buffer.from(i.media.data, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES)
      throw new ActionError("invalid-argument", `Files must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    mediaPath = `orgs/${ctx.orgId}/media/sim_${ctx.now()}_${Math.floor(Math.random() * 1e6)}`;
    try {
      await ctx.bucket.file(mediaPath).save(bytes, { contentType: i.media.mimeType });
    } catch (e) {
      ctx.log("upload failed", { error: (e as Error).message });
      throw new ActionError(
        "failed-precondition",
        "The upload could not be stored: Cloud Storage is not reachable right now. Send a screenshot or voice note to the Telegram bot instead.",
      );
    }
    i.kind = i.media.mimeType.startsWith("image/") ? "image" : "voice";
  }

  const target = await customers(ctx.db, ctx.orgId).doc(i.customerId).get();
  if (!target.exists) throw new ActionError("not-found", "Customer not found");
  // Simulated messages stay on sample customers. A real customer's conversation is never touched by the demo tools.
  if (!(target.data() as CustomerDoc).sample)
    throw new ActionError(
      "failed-precondition",
      "Simulated messages can only be sent as sample customers",
    );
  return recordInbound(ctx, {
    customerId: i.customerId,
    channel: i.channel as Channel,
    transport: "sim",
    text: i.text,
    kind: i.kind,
    at: ctx.now(),
    voiceSecs: i.voiceSecs,
    imageText: i.imageText,
    viaButton: i.viaButton,
    ...(mediaPath ? { mediaPath, mediaMime: i.media!.mimeType } : {}),
  });
}

export async function resetDemo(ctx: Ctx, actor: Actor) {
  await requireDemo(ctx);
  const out = await seedDemoData(ctx);
  await writeAudit(ctx, actor.email, "demo", "demo data reset", "human");
  return out;
}

// ── comments ───────────────────────────────────────────────────────────────────

async function loadComment(ctx: Ctx, commentId: string, actor?: Actor) {
  const ref = comments(ctx.db, ctx.orgId).doc(commentId);
  const snap = await ref.get();
  if (!snap.exists) throw new ActionError("not-found", "Comment not found");
  const c = snap.data() as CommentDoc;
  if (actor?.role === "judge" && !c.sample)
    throw new ActionError(
      "permission-denied",
      "Judges can only act on sample comments, never on a real public comment",
    );
  return { ref, c };
}

/** Real Meta calls need a page token. Sample and simulated comments never call Meta. */
function metaTarget(
  ctx: Ctx,
  c: CommentDoc,
): { token: string; platform: "instagram" | "facebook" } | null {
  if (c.sample || (c.platform !== "instagram" && c.platform !== "facebook"))
    return null;
  if (!ctx.metaPageToken)
    throw new ActionError(
      "failed-precondition",
      "Meta is not connected for this workspace yet, so this comment cannot be changed on the platform.",
    );
  return { token: ctx.metaPageToken, platform: c.platform };
}

export async function replyToComment(
  ctx: Ctx,
  actor: Actor,
  a: { commentId: string; text: string },
) {
  const { ref, c } = await loadComment(ctx, a.commentId, actor);
  const text = a.text.trim();
  if (text.length < 2 || text.length > 1000)
    throw new ActionError(
      "invalid-argument",
      "A reply must be 2 to 1000 characters",
    );
  const guard = checkOutbound(text, { officialDomains: await officialDomainsOf(ctx), linkPolicy: "no-lookalikes" });
  if (!guard.ok) {
    await writeAudit(
      ctx,
      actor.email,
      "blocked",
      `Public reply blocked: ${guard.violations.join("; ")}`,
      "guard",
    );
    throw new ActionError(
      "failed-precondition",
      `Reply blocked by policy: ${guard.violations.join("; ")}`,
    );
  }
  const target = metaTarget(ctx, c);
  if (target)
    await postCommentReply(target.token, target.platform, c.externalId, text);
  await ref.update({
    status: "handled",
    reply: { text, by: actor.name, at: ctx.now() },
  });
  await writeAudit(
    ctx,
    actor.email,
    "comment-reply",
    `${c.platform} · ${c.author}: ${c.intent}`,
    "human",
  );
}

export async function hideComment(
  ctx: Ctx,
  actor: Actor,
  a: { commentId: string; hidden: boolean },
) {
  const { ref, c } = await loadComment(ctx, a.commentId, actor);
  const target = metaTarget(ctx, c);
  if (target)
    await setCommentHidden(
      target.token,
      target.platform,
      c.externalId,
      a.hidden,
    );
  await ref.update({ status: a.hidden ? "hidden" : "new" });
  await writeAudit(
    ctx,
    actor.email,
    a.hidden ? "comment-hide" : "comment-unhide",
    `${c.platform} · ${c.author}: ${c.riskReason || c.intent}`,
    "human",
  );
}

/** Tags a post with the campaign it belongs to. An empty value clears the tag. */
export async function setPostCampaign(ctx: Ctx, actor: Actor, a: { postKey: string; campaign: string }) {
  const ref = posts(ctx.db, ctx.orgId).doc(a.postKey);
  const snap = await ref.get();
  if (!snap.exists) throw new ActionError("not-found", "Post not found");
  await ref.update({ campaign: a.campaign ? a.campaign : FieldValue.delete() });
  await writeAudit(ctx, actor.email, "post-campaign", `${snap.data()?.label ?? a.postKey} → ${a.campaign || "Uncategorised"}`, "human");
}

export async function handleComment(
  ctx: Ctx,
  actor: Actor,
  a: { commentId: string },
) {
  const { ref, c } = await loadComment(ctx, a.commentId, actor);
  await ref.update({ status: "handled" });
  await writeAudit(
    ctx,
    actor.email,
    "comment-handled",
    `${c.platform} · ${c.author}`,
    "human",
  );
}

const SimComment = z.object({
  platform: z
    .enum(["instagram", "facebook", "youtube", "x", "tiktok"])
    .default("instagram"),
  postId: z.string().min(1).max(80).default("demo-post"),
  postLabel: z.string().max(120).optional(),
  author: z.string().min(1).max(60).default("@demo_user"),
  text: z.string().min(1).max(2000),
});

/** Adds a sample comment through the same classification path as a real one. */
export async function simulateComment(ctx: Ctx, _actor: Actor, input: unknown) {
  await requireDemo(ctx);
  const p = SimComment.safeParse(input);
  if (!p.success)
    throw new ActionError(
      "invalid-argument",
      p.error.issues[0]?.message ?? "Invalid comment",
    );
  const i = p.data;
  const r = await ingestComment(ctx, {
    platform: i.platform as CommentPlatform,
    externalId: `sim${ctx.now()}${Math.floor(Math.random() * 1000)}`,
    postId: i.postId,
    postLabel: i.postLabel ?? "Demo post",
    author: i.author,
    text: i.text,
    at: ctx.now(),
    sample: true,
    origin: "simulated",
  });
  return { id: r.id };
}
