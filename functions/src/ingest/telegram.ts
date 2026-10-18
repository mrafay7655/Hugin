import { customers, tgEvents, tgRate } from "../lib/paths";
import { sendText } from "../telegram/client";
import type { CustomerDoc } from "../lib/model";
import type { Ctx } from "../agent/context";
import type { TelegramMessageEvent } from "../telegram/parse";
import { initialsOf, palette, recordInbound, type NormalizedInbound } from "./record";

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** The bot is public, so anyone can message it. Cap each chat so one person cannot run up the Gemini bill. */
export const TELEGRAM_HOURLY_LIMIT = 30;
export const LIMIT_NOTICE = "You've reached the demo limit for this hour. Please try again a little later. If this is urgent, call the number on the back of your card.";

/** Across every chat, per day. Many accounts together could otherwise run up the Gemini bill. Override with TELEGRAM_DAILY_LIMIT. */
export const dailyLimit = () => Number(process.env.TELEGRAM_DAILY_LIMIT) || 1500;
export const CAPACITY_NOTICE = "The demo has reached its limit for today. Please try again tomorrow. If this is urgent, call the number on the back of your card.";
const DAY = 24 * HOUR;

/** Counts this message against the chat's hourly allowance and the whole bot's daily allowance. */
async function countMessage(ctx: Ctx, chatId: string): Promise<{ chat: number; day: number }> {
  const chatRef = tgRate(ctx.db).doc(`${chatId}_${Math.floor(ctx.now() / HOUR)}`);
  const dayRef = tgRate(ctx.db).doc(`global_${Math.floor(ctx.now() / DAY)}`);
  return ctx.db.runTransaction(async (tx) => {
    const [c, d] = await Promise.all([tx.get(chatRef), tx.get(dayRef)]);
    const chat = ((c.data()?.count as number | undefined) ?? 0) + 1;
    const day = ((d.data()?.count as number | undefined) ?? 0) + 1;
    tx.set(chatRef, { count: chat, expireAt: new Date(ctx.now() + 2 * HOUR) });
    tx.set(dayRef, { count: day, expireAt: new Date(ctx.now() + 2 * DAY) });
    return { chat, day };
  });
}

/** Claims an update id. Returns false if we have already seen it (Telegram retries on any non-2xx). */
async function claim(ctx: Ctx, id: string): Promise<boolean> {
  try {
    await tgEvents(ctx.db).doc(id).create({ at: ctx.now(), expireAt: new Date(ctx.now() + SEVEN_DAYS) });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false; // ALREADY_EXISTS
    throw e;
  }
}

/** Creates the customer for a Telegram chat on first contact, refreshing the display name after. */
export async function upsertTelegramCustomer(ctx: Ctx, chatId: string, name: string, username: string): Promise<string> {
  const id = `tg_${chatId}`;
  const ref = customers(ctx.db, ctx.orgId).doc(id);
  const snap = await ref.get();
  if (snap.exists) {
    if (name && snap.data()?.name !== name) await ref.update({ name, initials: initialsOf(name) });
    return id;
  }
  const doc: CustomerDoc = {
    name, initials: initialsOf(name), color: palette(chatId), phoneMasked: username ? `@${username}` : "Telegram", tgId: chatId, ...(username ? { handle: `@${username}` } : {}),
    tier: "Everyday", since: new Date(ctx.now()).getFullYear(), city: "", language: "en", csat: 0, churn: "Low", segment: "unassigned", traits: [], summary: "New customer via Telegram.",
  };
  await ref.set(doc);
  return id;
}

function normalize(e: TelegramMessageEvent, customerId: string): NormalizedInbound {
  const base = { customerId, channel: "telegram" as const, transport: "telegram" as const, at: e.at };
  const b = e.body;
  switch (b.type) {
    case "text": return { ...base, kind: "text", text: b.text };
    case "button_reply": return { ...base, kind: "text", text: b.title, viaButton: true };
    case "voice": return { ...base, kind: "voice", text: "", voiceSecs: b.seconds, mediaId: b.fileId, mediaMime: b.mimeType };
    case "photo": return { ...base, kind: "image", text: b.caption, mediaId: b.fileId, mediaMime: "image/jpeg" };
    default: return { ...base, kind: "text", text: `[unsupported message type: ${b.raw}]` };
  }
}

/** Persists every event of a verified Telegram update. Idempotent, so safe to receive twice. */
export async function handleTelegramEvents(ctx: Ctx, events: TelegramMessageEvent[]): Promise<{ stored: number; duplicates: number; limited: number }> {
  let stored = 0, duplicates = 0, limited = 0;
  for (const e of events) {
    if (!(await claim(ctx, e.id))) {
      duplicates++;
      continue;
    }
    const n = await countMessage(ctx, e.chatId);
    if (n.day > dailyLimit()) {
      limited++;
      // The first message a chat sends after the cap gets a notice, then silence.
      if (n.chat === 1 && ctx.telegram) await sendText(ctx.telegram, e.chatId, CAPACITY_NOTICE).catch(() => undefined);
      continue;
    }
    if (n.chat > TELEGRAM_HOURLY_LIMIT) {
      limited++;
      // Tell them once per hour, then stay quiet. Never let the notice fail the delivery.
      if (n.chat === TELEGRAM_HOURLY_LIMIT + 1 && ctx.telegram) await sendText(ctx.telegram, e.chatId, LIMIT_NOTICE).catch(() => undefined);
      continue;
    }
    const customerId = await upsertTelegramCustomer(ctx, e.chatId, e.name, e.username);
    await recordInbound(ctx, normalize(e, customerId));
    stored++;
  }
  return { stored, duplicates, limited };
}
