import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTelegramUpdate } from "../src/telegram/parse";
import { answerCallback, downloadFile, sendButtons, sendText, TelegramError } from "../src/telegram/client";

const msg = (extra: Record<string, unknown>, chat: Record<string, unknown> = { id: 555, type: "private" }, from: Record<string, unknown> = { id: 555, first_name: "Ayesha", last_name: "Khan", username: "ayesha_k" }) => ({
  update_id: 9001,
  message: { message_id: 1, from, chat, date: 1_791_790_000, ...extra },
});

describe("parseTelegramUpdate()", () => {
  it("reads a text message", () => {
    const [e] = parseTelegramUpdate(msg({ text: "What is the international wire fee?" }));
    expect(e).toMatchObject({ id: "u9001", chatId: "555", name: "Ayesha Khan", username: "ayesha_k", at: 1_791_790_000_000 });
    expect(e.body).toEqual({ type: "text", text: "What is the international wire fee?" });
  });
  it("treats /start as a greeting", () => {
    expect(parseTelegramUpdate(msg({ text: "/start" }))[0].body).toEqual({ type: "text", text: "Hello" });
    expect(parseTelegramUpdate(msg({ text: "/start abc123" }))[0].body).toEqual({ type: "text", text: "Hello" });
  });
  it("reads a voice note", () => {
    const [e] = parseTelegramUpdate(msg({ voice: { file_id: "VOICE1", mime_type: "audio/ogg", duration: 7 } }));
    expect(e.body).toEqual({ type: "voice", fileId: "VOICE1", mimeType: "audio/ogg", seconds: 7 });
  });
  it("takes the largest photo size and keeps the caption", () => {
    const [e] = parseTelegramUpdate(msg({ photo: [{ file_id: "SMALL" }, { file_id: "MEDIUM" }, { file_id: "LARGE" }], caption: "is this real?" }));
    expect(e.body).toEqual({ type: "photo", fileId: "LARGE", caption: "is this real?" });
  });
  it("reads a button tap as a button reply with its own idempotency key", () => {
    const [e] = parseTelegramUpdate({ update_id: 9002, callback_query: { id: "cbq77", from: { id: 555, first_name: "Ayesha" }, data: "Yes, I did", message: { chat: { id: 555, type: "private" } } } });
    expect(e.id).toBe("cbcbq77");
    expect(e.body).toEqual({ type: "button_reply", title: "Yes, I did", callbackId: "cbq77" });
  });
  it("labels a type it does not handle instead of dropping it", () => {
    expect(parseTelegramUpdate(msg({ sticker: { file_id: "S" } }))[0].body).toEqual({ type: "unsupported", raw: "sticker" });
  });
  it("ignores groups, channels, bots and junk", () => {
    expect(parseTelegramUpdate(msg({ text: "hi" }, { id: -100, type: "supergroup" }))).toEqual([]);
    expect(parseTelegramUpdate(msg({ text: "hi" }, { id: 5, type: "private" }, { id: 5, is_bot: true, first_name: "Bot" }))).toEqual([]);
    expect(parseTelegramUpdate({ update_id: 1, edited_message: {} })).toEqual([]);
    expect(parseTelegramUpdate(null)).toEqual([]);
    expect(parseTelegramUpdate("nope")).toEqual([]);
  });
  it("falls back to the username, then a generic name", () => {
    expect(parseTelegramUpdate(msg({ text: "hi" }, undefined, { id: 1, username: "only_user" }))[0].name).toBe("only_user");
    expect(parseTelegramUpdate(msg({ text: "hi" }, undefined, { id: 1 }))[0].name).toBe("Telegram user");
  });
});

describe("Telegram client", () => {
  const creds = { token: "123456:SECRET-TOKEN" };
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let reply: { status: number; json: unknown } = { status: 200, json: { ok: true, result: { message_id: 42 } } };

  beforeEach(() => {
    calls.length = 0;
    reply = { status: 200, json: { ok: true, result: { message_id: 42 } } };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response(JSON.stringify(reply.json), { status: reply.status });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends text to the right chat and returns the message id", async () => {
    expect(await sendText(creds, "555", "hello")).toBe("42");
    expect(calls[0].url).toBe("https://api.telegram.org/bot123456:SECRET-TOKEN/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "555", text: "hello" });
  });
  it("sends at most 3 inline buttons and caps their titles", async () => {
    await sendButtons(creds, "555", "Did you enter details?", ["Yes, I did", "No, I didn't", "Not sure what to do now", "Fourth"]);
    const row = (calls[0].body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0];
    expect(row).toHaveLength(3);
    expect(row[2].text.length).toBeLessThanOrEqual(20);
    expect(row[0]).toEqual({ text: "Yes, I did", callback_data: "Yes, I did" });
  });
  it("clips messages over Telegram's 4096 character limit", async () => {
    await sendText(creds, "555", "x".repeat(5000));
    expect(String(calls[0].body.text).length).toBeLessThanOrEqual(4000);
  });
  it("never puts the bot token in an error message", async () => {
    reply = { status: 403, json: { ok: false, description: "Forbidden: bot was blocked by the user" } };
    const err = await sendText(creds, "555", "hi").catch((e) => e as TelegramError);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).message).toContain("bot was blocked by the user");
    expect((err as TelegramError).message).not.toContain("SECRET-TOKEN");
    expect((err as TelegramError).status).toBe(403);
  });
  it("answers a callback query", async () => {
    await answerCallback(creds, "cbq77");
    expect(calls[0].url).toContain("/answerCallbackQuery");
    expect(calls[0].body).toEqual({ callback_query_id: "cbq77" });
  });
  it("downloads a file in two steps and maps the extension to a mime type", async () => {
    reply = { status: 200, json: { ok: true, result: { file_path: "voice/file_9.oga" } } };
    const f = await downloadFile(creds, "VOICE1", "application/octet-stream");
    expect(f.mimeType).toBe("audio/ogg");
    expect([...f.data]).toEqual([1, 2, 3]);
    expect(calls[1].url).toBe("https://api.telegram.org/file/bot123456:SECRET-TOKEN/voice/file_9.oga");
  });
  it("fails clearly when Telegram returns no file path", async () => {
    reply = { status: 200, json: { ok: true, result: {} } };
    await expect(downloadFile(creds, "X", "image/jpeg")).rejects.toThrow("no path");
  });
});
