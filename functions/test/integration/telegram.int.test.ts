import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliver, OutboundBlocked } from "../../src/agent/outbound";
import { processConversation } from "../../src/agent/run";
import { CAPACITY_NOTICE, handleTelegramEvents, LIMIT_NOTICE, TELEGRAM_HOURLY_LIMIT } from "../../src/ingest/telegram";
import { parseTelegramUpdate } from "../../src/telegram/parse";
import { seedDemoData } from "../../src/seed/demo";
import { conversations, customers } from "../../src/lib/paths";
import type { ConversationDoc, CustomerDoc } from "../../src/lib/model";
import { cardLocked, makeCtx, snapshot } from "./helpers";

const ctx = makeCtx({ telegram: { token: "999:TEST-TOKEN" } });
const CHAT = "424242";
const update = (updateId: number, extra: Record<string, unknown>) => ({
  update_id: updateId,
  message: { message_id: updateId, from: { id: Number(CHAT), first_name: "Ayesha", last_name: "Khan", username: "ayesha_k" }, chat: { id: Number(CHAT), type: "private" }, date: Math.floor(Date.now() / 1000), ...extra },
});

/** A fake Telegram: records every API call and answers like the real one. */
const sent: { method: string; body: Record<string, any> }[] = [];
beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    sent.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

beforeAll(async () => {
  await seedDemoData(ctx);
});

describe("Telegram ingestion", () => {
  it("creates the customer and conversation on first contact, and ignores a retried update", async () => {
    const events = parseTelegramUpdate(update(5001, { text: "Hi, what is the international wire fee?" }));
    const r1 = await handleTelegramEvents(ctx, events);
    const r2 = await handleTelegramEvents(ctx, events);
    expect(r1).toEqual({ stored: 1, duplicates: 0, limited: 0 });
    expect(r2).toEqual({ stored: 0, duplicates: 1, limited: 0 });

    const customer = (await customers(ctx.db, ctx.orgId).doc(`tg_${CHAT}`).get()).data() as CustomerDoc;
    expect(customer).toMatchObject({ name: "Ayesha Khan", tgId: CHAT, handle: "@ayesha_k", phoneMasked: "@ayesha_k" });

    const conv = (await conversations(ctx.db, ctx.orgId).doc(`tg_${CHAT}_telegram`).get()).data() as ConversationDoc;
    expect(conv).toMatchObject({ channel: "telegram", transport: "telegram", customerId: `tg_${CHAT}` });
  });
});

describe("Telegram end to end", () => {
  it("the agent answers a fee question through the Telegram API, with a citation", async () => {
    await processConversation(ctx, `tg_${CHAT}_telegram`);
    const s = await snapshot(ctx, `tg_${CHAT}_telegram`);
    expect(s.outs).toHaveLength(1);
    expect(s.outs[0].status).toBe("sent");
    expect(s.outs[0].cite).toBeTruthy();
    const call = sent.find((c) => c.method === "sendMessage");
    expect(call?.body).toMatchObject({ chat_id: CHAT });
    expect(String(call?.body.text)).toBe(s.outs[0].text);
  });

  it("an OTP scam report locks the card and sends the reassurance with tappable buttons or text", async () => {
    await handleTelegramEvents(ctx, parseTelegramUpdate(update(5002, { text: "Someone called asking for my one-time code. I did not give it." })));
    await processConversation(ctx, `tg_${CHAT}_telegram`);
    const s = await snapshot(ctx, `tg_${CHAT}_telegram`);
    expect(s.lastTrace.policyId).toBe("P-07");
    expect(s.conv.status).toBe("fraud");
    expect(await cardLocked(ctx, `tg_${CHAT}`)).toBe(true);
    expect(sent.filter((c) => c.method === "sendMessage").length).toBeGreaterThan(0);
  });

  it("the outbound guard still blocks a message that asks for a code, and nothing reaches Telegram", async () => {
    const conv = (await conversations(ctx.db, ctx.orgId).doc(`tg_${CHAT}_telegram`).get()).data() as ConversationDoc;
    const customer = { id: `tg_${CHAT}`, ...((await customers(ctx.db, ctx.orgId).doc(`tg_${CHAT}`).get()).data() as CustomerDoc) };
    await expect(deliver(ctx, { convId: `tg_${CHAT}_telegram`, conv, customer, text: "Please share your OTP so I can verify you", author: "ai" })).rejects.toBeInstanceOf(OutboundBlocked);
    expect(sent).toHaveLength(0);
  });

  it("there is no 24-hour window on Telegram", async () => {
    const stale = { ...((await conversations(ctx.db, ctx.orgId).doc(`tg_${CHAT}_telegram`).get()).data() as ConversationDoc), lastCustomerMessageAt: Date.now() - 72 * 3_600_000 };
    const customer = { id: `tg_${CHAT}`, ...((await customers(ctx.db, ctx.orgId).doc(`tg_${CHAT}`).get()).data() as CustomerDoc) };
    await deliver(ctx, { convId: `tg_${CHAT}_telegram`, conv: stale, customer, text: "Following up on your earlier question.", author: "human", authorName: "Dana" });
    expect(sent.find((c) => c.method === "sendMessage")?.body).toMatchObject({ chat_id: CHAT, text: "Following up on your earlier question." });
  });

  it("fails clearly, instead of silently dropping the reply, when the bot token is missing", async () => {
    const noCreds = makeCtx();
    const conv = (await conversations(ctx.db, ctx.orgId).doc(`tg_${CHAT}_telegram`).get()).data() as ConversationDoc;
    const customer = { id: `tg_${CHAT}`, ...((await customers(ctx.db, ctx.orgId).doc(`tg_${CHAT}`).get()).data() as CustomerDoc) };
    await expect(deliver(noCreds, { convId: `tg_${CHAT}_telegram`, conv, customer, text: "Hello", author: "human", authorName: "Dana" })).rejects.toThrow("Telegram credentials are not configured");
  });
});

describe("Telegram rate limit", () => {
  it("stores up to the hourly limit per chat, tells the sender once, then stays quiet", async () => {
    const chat = 777001;
    const from = { id: chat, first_name: "Flood", username: "flood_test" };
    const mk = (i: number) => ({ update_id: 900000 + i, message: { message_id: i, from, chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000), text: `hello ${i}` } });
    let stored = 0;
    for (let i = 0; i < TELEGRAM_HOURLY_LIMIT; i++) stored += (await handleTelegramEvents(ctx, parseTelegramUpdate(mk(i)))).stored;
    expect(stored).toBe(TELEGRAM_HOURLY_LIMIT);

    const over1 = await handleTelegramEvents(ctx, parseTelegramUpdate(mk(TELEGRAM_HOURLY_LIMIT)));
    const over2 = await handleTelegramEvents(ctx, parseTelegramUpdate(mk(TELEGRAM_HOURLY_LIMIT + 1)));
    expect([over1.stored, over1.limited, over2.stored, over2.limited]).toEqual([0, 1, 0, 1]);
    const notices = sent.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(chat));
    expect(notices).toHaveLength(1);
    expect(notices[0].body.text).toBe(LIMIT_NOTICE);
  });
  it("a different chat is not affected", async () => {
    const r = await handleTelegramEvents(ctx, parseTelegramUpdate({ update_id: 990001, message: { message_id: 1, from: { id: 777002, first_name: "Other" }, chat: { id: 777002, type: "private" }, date: Math.floor(Date.now() / 1000), text: "hi" } }));
    expect(r).toEqual({ stored: 1, duplicates: 0, limited: 0 });
  });
});

describe("Telegram daily cap across every chat", () => {
  it("stops storing messages once the whole bot has hit its daily limit, and tells a new chat once", async () => {
    // Several chats together, each well under its own hourly limit, as a swarm of accounts would look.
    process.env.TELEGRAM_DAILY_LIMIT = "5";
    try {
      const mk = (chat: number, id: number) => parseTelegramUpdate({ update_id: id, message: { message_id: id, from: { id: chat, first_name: "Bot" + chat }, chat: { id: chat, type: "private" }, date: Math.floor(Date.now() / 1000), text: "hello" } });
      const results = [];
      for (let i = 0; i < 9; i++) results.push(await handleTelegramEvents(ctx, mk(7000 + i, 9000 + i)));
      const stored = results.reduce((a, r) => a + r.stored, 0);
      const limited = results.reduce((a, r) => a + r.limited, 0);
      expect(stored + limited).toBe(9);
      expect(limited).toBeGreaterThanOrEqual(4); // everything past the cap is refused
      expect(stored).toBeLessThanOrEqual(5);
      const notices = sent.filter((c) => c.method === "sendMessage" && c.body.text === CAPACITY_NOTICE);
      expect(notices.length).toBe(limited); // each new chat gets exactly one notice
    } finally {
      delete process.env.TELEGRAM_DAILY_LIMIT;
    }
  });
});
