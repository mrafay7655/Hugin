import { conversations, convId as makeConvId, customers, MESSAGE_RETENTION_MS, messages, waIndex } from "../lib/paths";
import type { ConversationDoc, CustomerDoc, MessageDoc } from "../lib/model";
import type { Channel, MessageKind, Transport } from "../types";
import type { Ctx } from "../agent/context";

export interface NormalizedInbound {
  customerId: string;
  channel: Channel;
  transport: Transport;
  text: string;
  kind: MessageKind;
  at: number;
  voiceSecs?: number;
  imageText?: string;
  mediaId?: string;
  mediaMime?: string;
  wamid?: string;
  /** The customer tapped one of our reply buttons. */
  viaButton?: boolean;
  /** A file already stored in Cloud Storage (web chat uploads). */
  mediaPath?: string;
}

const PALETTE: [string, string][] = [
  ["#E4E6FB", "#3D45B0"], ["#E9F7EF", "#17763F"], ["#FDF5E6", "#8A5A10"], ["#FDECEC", "#B42E2E"],
  ["#EAF2FD", "#225FAB"], ["#F3E8FF", "#6B3FA0"], ["#E6F6F5", "#1F7A77"], ["#EFEFF1", "#3F3F46"],
];
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export const palette = (key: string): [string, string] => PALETTE[hash(key) % PALETTE.length];

export const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";

/** Show only the first digit and the last four. The full number is never displayed. */
export const maskPhone = (waId: string) => (waId.length > 5 ? `+${waId[0]} ••• ${waId.slice(-4)}` : "•••");

/** Creates the customer for a WhatsApp sender on first contact, refreshing the display name after. */
export async function upsertWhatsAppCustomer(ctx: Ctx, waId: string, profileName: string): Promise<string> {
  const id = `wa_${waId}`;
  const ref = customers(ctx.db, ctx.orgId).doc(id);
  const snap = await ref.get();
  if (snap.exists) {
    if (profileName && snap.data()?.name !== profileName) await ref.update({ name: profileName, initials: initialsOf(profileName) });
    return id;
  }
  const name = profileName || `+${waId}`;
  const doc: CustomerDoc = {
    name, initials: initialsOf(name), color: PALETTE[hash(waId) % PALETTE.length], phoneMasked: maskPhone(waId), waId,
    tier: "Everyday", since: new Date(ctx.now()).getFullYear(), city: "", language: "en", csat: 0, churn: "Low", segment: "unassigned", traits: [], summary: "New customer via WhatsApp.",
  };
  await ref.set(doc);
  return id;
}

/**
 * Writes one inbound customer message and updates its conversation. The agent is triggered
 * separately by the message document being created, so the real webhook and the demo
 * simulator go through exactly the same path afterwards.
 */
export async function recordInbound(ctx: Ctx, n: NormalizedInbound): Promise<{ convId: string; msgId: string }> {
  const convId = makeConvId(n.customerId, n.channel);
  const convRef = conversations(ctx.db, ctx.orgId).doc(convId);
  const preview = n.kind === "voice" ? "Voice message" : n.kind === "image" ? `Screenshot${n.text ? `: ${n.text}` : ""}` : n.text;

  await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(convRef);
    if (!snap.exists) {
      const fresh: ConversationDoc = {
        customerId: n.customerId, channel: n.channel, transport: n.transport, status: "open", decision: "auto_resolved", intent: "…", priority: 1,
        unread: true, thinking: false, mode: "agent", lastAt: n.at, lastPreview: preview.slice(0, 120), lastKind: n.kind,
        lastCustomerMessageAt: n.at, assignee: null, caseId: null, approval: null, agentLease: null,
        origin: n.transport === "sim" ? "simulated" : "live",
      };
      tx.set(convRef, fresh);
    } else {
      const existing = snap.data() as ConversationDoc;
      const wasResolved = existing.status === "resolved";
      // A simulated message must never turn a real WhatsApp or Telegram conversation into a simulated one,
      // or later replies would stop reaching the customer.
      const keepTransport = n.transport === "sim" && existing.transport !== "sim";
      tx.update(convRef, {
        lastAt: n.at, lastPreview: preview.slice(0, 120), lastKind: n.kind, lastCustomerMessageAt: n.at, unread: true,
        ...(keepTransport ? {} : { transport: n.transport }), ...(wasResolved ? { status: "open" } : {}),
      });
    }
  });

  const doc: MessageDoc = {
    dir: "in", author: "customer", kind: n.kind, text: n.text, at: n.at, status: "received", processed: false,
    ...(n.voiceSecs ? { voiceSecs: n.voiceSecs } : {}), ...(n.imageText ? { imageText: n.imageText } : {}),
    ...(n.mediaId ? { mediaId: n.mediaId, mediaMime: n.mediaMime ?? "" } : {}), ...(n.wamid ? { wamid: n.wamid } : {}),
    ...(n.viaButton ? { viaButton: true } : {}),
    ...(n.mediaPath ? { mediaPath: n.mediaPath, mediaMime: n.mediaMime ?? "" } : {}),
    ...(n.transport !== "sim" ? { expireAt: new Date(ctx.now() + MESSAGE_RETENTION_MS) } : {}),
  };
  const ref = await messages(ctx.db, ctx.orgId, convId).add(doc);
  if (n.wamid) await waIndex(ctx.db).doc(n.wamid).set({ orgId: ctx.orgId, convId, msgId: ref.id });
  return { convId, msgId: ref.id };
}
