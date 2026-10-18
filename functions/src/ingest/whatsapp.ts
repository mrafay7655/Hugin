import { waEvents, waIndex, messages } from "../lib/paths";
import type { Ctx } from "../agent/context";
import type { InboundMessageEvent, StatusEvent, WhatsAppEvent } from "../whatsapp/parse";
import { recordInbound, upsertWhatsAppCustomer, type NormalizedInbound } from "./record";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

/** Claims a WhatsApp message id. Returns false if we have already seen it (Meta retries). */
async function claim(ctx: Ctx, id: string): Promise<boolean> {
  try {
    await waEvents(ctx.db).doc(id).create({ at: ctx.now(), expireAt: new Date(ctx.now() + SEVEN_DAYS) });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    throw e;
  }
}

function normalize(e: InboundMessageEvent, customerId: string): NormalizedInbound {
  const base = { customerId, channel: "whatsapp" as const, transport: "whatsapp" as const, at: e.at, wamid: e.id };
  const b = e.body;
  switch (b.type) {
    case "text": return { ...base, kind: "text", text: b.text };
    case "button_reply": return { ...base, kind: "text", text: b.title, viaButton: true };
    case "audio": return { ...base, kind: "voice", text: "", mediaId: b.mediaId, mediaMime: b.mimeType };
    case "image": return { ...base, kind: "image", text: b.caption, mediaId: b.mediaId, mediaMime: b.mimeType };
    default: return { ...base, kind: "text", text: `[unsupported message type: ${b.raw}]` };
  }
}

async function applyStatus(ctx: Ctx, s: StatusEvent): Promise<void> {
  const idx = await waIndex(ctx.db).doc(s.id).get();
  if (!idx.exists) return; // status for a message we have no record of
  const { convId, msgId } = idx.data() as { convId: string; msgId: string };
  const ref = messages(ctx.db, ctx.orgId, convId).doc(msgId);
  const snap = await ref.get();
  if (!snap.exists) return;
  // Never move a message backwards (read -> delivered) when events arrive out of order.
  const order = ["received", "sent", "delivered", "read"];
  const current = snap.data()?.status as string;
  if (s.status !== "failed" && order.indexOf(s.status) <= order.indexOf(current)) return;
  await ref.update({ status: s.status, ...(s.error ? { error: s.error } : {}) });
}

/** Persists every event in a verified webhook delivery. Idempotent, so safe to receive twice. */
export async function handleWhatsAppEvents(ctx: Ctx, events: WhatsAppEvent[]): Promise<{ stored: number; duplicates: number; statuses: number }> {
  let stored = 0, duplicates = 0, statuses = 0;
  for (const e of events) {
    if (e.kind === "status") {
      await applyStatus(ctx, e);
      statuses++;
      continue;
    }
    if (!(await claim(ctx, e.id))) {
      duplicates++;
      continue;
    }
    const customerId = await upsertWhatsAppCustomer(ctx, e.from, e.profileName);
    await recordInbound(ctx, normalize(e, customerId));
    stored++;
  }
  return { stored, duplicates, statuses };
}
