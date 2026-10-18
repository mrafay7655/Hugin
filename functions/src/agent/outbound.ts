import { checkOutbound, windowOpen } from "../policy/guards";
import { conversations, MESSAGE_RETENTION_MS, messages, waIndex } from "../lib/paths";
import type { ConversationDoc, CustomerDoc, MessageDoc } from "../lib/model";
import { sendButtons, sendText } from "../whatsapp/client";
import { sendButtons as tgSendButtons, sendText as tgSendText } from "../telegram/client";
import { officialDomainsOf, writeAudit } from "./ops";
import { bump, health } from "./metrics";
import type { Ctx } from "./context";

export class OutboundBlocked extends Error {
  constructor(readonly reason: "guard" | "window", message: string) {
    super(message);
  }
}

export interface DeliverInput {
  convId: string;
  conv: ConversationDoc;
  customer: CustomerDoc & { id: string };
  text: string;
  buttons?: string[];
  cite?: { doc: string; section: string };
  author: "ai" | "human";
  authorName?: string;
  /** Domains this message warns about, so quoting them is not treated as a link. */
  warnsAbout?: string[];
}

/**
 * The single exit for every outbound message. Guards run here, in code, so they hold no matter
 * how the text was produced: blocked phrases, and the 24-hour WhatsApp service window.
 */
export async function deliver(ctx: Ctx, i: DeliverInput): Promise<string> {
  // The phishing reply names the bad domain on purpose, so the agent's link rule skips messages that carry a lookalike warning.
  const guard = checkOutbound(i.text, {
    allowRefundLanguage: i.author === "human",
    officialDomains: await officialDomainsOf(ctx),
    linkPolicy: i.author === "ai" ? "official-only" : "no-lookalikes",
    allowWarnedDomains: i.warnsAbout,
  });
  if (!guard.ok) {
    await writeAudit(ctx, i.author === "ai" ? "agent" : i.authorName ?? "human", "blocked", `Outbound blocked: ${guard.violations.join("; ")}`, "guard");
    await bump(ctx, { guardBlocks: 1, [i.author === "ai" ? "guardBlocksAgent" : "guardBlocksPeople"]: 1 });
    await health(ctx, "output-guard", { ok: true, detail: `blocked: ${guard.violations.join("; ")}` });
    throw new OutboundBlocked("guard", `Message blocked by policy: ${guard.violations.join("; ")}`);
  }

  const live = i.conv.transport === "whatsapp";
  if (live && !windowOpen(i.conv.lastCustomerMessageAt, ctx.now())) {
    throw new OutboundBlocked("window", "The 24-hour WhatsApp window is closed. Only an approved template can be sent.");
  }

  let wamid: string | undefined;
  let status: MessageDoc["status"] = "delivered";
  if (i.conv.transport === "telegram") {
    // Telegram has no 24-hour window and no template rule: the guard above is the only gate.
    if (!ctx.telegram) throw new Error("Telegram credentials are not configured");
    const chatId = i.customer.tgId;
    if (!chatId) throw new Error("Customer has no Telegram chat id");
    try {
      await (i.buttons?.length ? tgSendButtons(ctx.telegram, chatId, i.text, i.buttons) : tgSendText(ctx.telegram, chatId, i.text));
    } catch (e) {
      await health(ctx, "telegram", { ok: false, error: `Sending failed: ${(e as Error).message}` });
      throw e;
    }
    status = "sent";
  } else if (live) {
    if (!ctx.whatsapp) throw new Error("WhatsApp credentials are not configured");
    const to = i.customer.waId;
    if (!to) throw new Error("Customer has no WhatsApp id");
    try {
      wamid = i.buttons?.length ? await sendButtons(ctx.whatsapp, to, i.text, i.buttons) : await sendText(ctx.whatsapp, to, i.text);
    } catch (e) {
      await health(ctx, "whatsapp", { ok: false, error: `Sending failed: ${(e as Error).message}` });
      throw e;
    }
    status = "sent";
  }

  const doc: MessageDoc = {
    dir: "out", author: i.author, ...(i.authorName ? { authorName: i.authorName } : {}), kind: "text", text: i.text,
    ...(i.buttons?.length ? { buttons: i.buttons } : {}), ...(i.cite ? { cite: i.cite } : {}),
    at: ctx.now(), status, ...(wamid ? { wamid } : {}),
    ...(i.conv.transport !== "sim" ? { expireAt: new Date(ctx.now() + MESSAGE_RETENTION_MS) } : {}),
  };
  const ref = await messages(ctx.db, ctx.orgId, i.convId).add(doc);
  await bump(ctx, { messagesSent: 1, [`sent.${i.conv.channel}`]: 1, [i.author === "ai" ? "sentByAgent" : "sentByPeople"]: 1 });
  await health(ctx, "output-guard", { ok: true, detail: "passed" });
  if (wamid) await waIndex(ctx.db).doc(wamid).set({ orgId: ctx.orgId, convId: i.convId, msgId: ref.id });
  await conversations(ctx.db, ctx.orgId).doc(i.convId).update({ lastAt: doc.at, lastPreview: i.text.slice(0, 120), lastKind: "text" });
  return ref.id;
}
