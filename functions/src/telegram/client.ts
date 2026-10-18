/** Thin Telegram Bot API client. */
import { assertMediaSize } from "../lib/text";

export interface TelegramCreds {
  token: string;
}

// TELEGRAM_API_BASE lets tests point at a local fake of Telegram.
const API = () => process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
  }
}

/** The token is part of the URL Telegram expects, so it must never end up in an error message or a log. */
async function call<T>(c: TelegramCreds, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API()}/bot${c.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: { ok?: boolean; result?: T; description?: string } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok || json.ok === false) throw new TelegramError(`Telegram ${method} ${res.status}: ${json.description ?? "request failed"}`, res.status, json.description);
  return json.result as T;
}

interface SentMessage {
  message_id: number;
}

/** Telegram rejects messages over 4096 characters. */
const clip = (s: string) => (s.length > 4000 ? `${s.slice(0, 3999)}…` : s);

export async function sendText(c: TelegramCreds, chatId: string, text: string): Promise<string> {
  const r = await call<SentMessage>(c, "sendMessage", { chat_id: chatId, text: clip(text), disable_web_page_preview: true });
  return String(r.message_id);
}

/** Up to 3 quick-reply buttons in one row. The tapped title comes back as callback data, so it is capped at 60 bytes. */
export async function sendButtons(c: TelegramCreds, chatId: string, text: string, buttons: string[]): Promise<string> {
  const row = buttons.slice(0, 3).map((title) => ({ text: title.slice(0, 20), callback_data: title.slice(0, 20) }));
  const r = await call<SentMessage>(c, "sendMessage", { chat_id: chatId, text: clip(text), disable_web_page_preview: true, reply_markup: { inline_keyboard: [row] } });
  return String(r.message_id);
}

/** Stops the spinner on a tapped button. Best effort. */
export async function answerCallback(c: TelegramCreds, callbackId: string): Promise<void> {
  await call(c, "answerCallbackQuery", { callback_query_id: callbackId });
}

/** Resolves a file id to a path, then downloads the bytes. */
export async function downloadFile(c: TelegramCreds, fileId: string, fallbackMime: string): Promise<{ data: Buffer; mimeType: string }> {
  const f = await call<{ file_path?: string }>(c, "getFile", { file_id: fileId });
  if (!f.file_path) throw new TelegramError("Telegram getFile returned no path", 404);
  const res = await fetch(`${API()}/file/bot${c.token}/${f.file_path}`);
  if (!res.ok) throw new TelegramError(`Telegram file download ${res.status}`, res.status);
  assertMediaSize(res.headers.get("content-length"));
  const ext = f.file_path.split(".").pop()?.toLowerCase();
  const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "oga" || ext === "ogg" ? "audio/ogg" : fallbackMime;
  const data = Buffer.from(await res.arrayBuffer());
  assertMediaSize(null, data.byteLength);
  return { data, mimeType };
}
