/** Normalizes a Telegram Bot API update into flat events. Never throws on odd input. */

export type TelegramBody =
  | { type: "text"; text: string }
  | { type: "voice"; fileId: string; mimeType: string; seconds: number }
  | { type: "photo"; fileId: string; caption: string }
  | { type: "button_reply"; title: string; callbackId: string }
  | { type: "unsupported"; raw: string };

export interface TelegramMessageEvent {
  /** Idempotency key: the update id, or the callback query id for a button tap. */
  id: string;
  chatId: string;
  /** Display name from the Telegram profile. */
  name: string;
  username: string;
  /** Epoch milliseconds. */
  at: number;
  body: TelegramBody;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idOf = (v: unknown): string => (typeof v === "number" || typeof v === "string" ? String(v) : "");

const displayName = (from: Json): string => [str(from.first_name), str(from.last_name)].filter(Boolean).join(" ") || str(from.username) || "Telegram user";

function parseBody(m: Json): TelegramBody {
  if (typeof m.text === "string") {
    // "/start" is how every Telegram chat with a bot begins. Treat it as a greeting.
    const t = m.text.trim();
    return { type: "text", text: /^\/start\b/i.test(t) ? "Hello" : t };
  }
  const voice = obj(m.voice);
  if (str(voice.file_id)) return { type: "voice", fileId: str(voice.file_id), mimeType: str(voice.mime_type) || "audio/ogg", seconds: Number(voice.duration) || 0 };
  const photos = arr(m.photo);
  const biggest = obj(photos[photos.length - 1]);
  if (str(biggest.file_id)) return { type: "photo", fileId: str(biggest.file_id), caption: str(m.caption) };
  return { type: "unsupported", raw: Object.keys(m).filter((k) => !["message_id", "from", "chat", "date"].includes(k))[0] ?? "unknown" };
}

/** Private chats only: a bank assistant must not answer in groups or channels. */
export function parseTelegramUpdate(payload: unknown): TelegramMessageEvent[] {
  const u = obj(payload);
  const updateId = idOf(u.update_id);
  const out: TelegramMessageEvent[] = [];

  const message = obj(u.message);
  const chat = obj(message.chat);
  if (updateId && idOf(chat.id) && str(chat.type) === "private") {
    const from = obj(message.from);
    if (from.is_bot !== true) {
      const date = Number(message.date);
      out.push({
        id: `u${updateId}`, chatId: idOf(chat.id), name: displayName(from), username: str(from.username),
        at: Number.isFinite(date) && date > 0 ? date * 1000 : Date.now(), body: parseBody(message),
      });
    }
  }

  const cb = obj(u.callback_query);
  const cbChat = obj(obj(cb.message).chat);
  if (idOf(cb.id) && idOf(cbChat.id) && str(cbChat.type) === "private" && str(cb.data)) {
    const from = obj(cb.from);
    out.push({
      id: `cb${idOf(cb.id)}`, chatId: idOf(cbChat.id), name: displayName(from), username: str(from.username), at: Date.now(),
      body: { type: "button_reply", title: str(cb.data), callbackId: idOf(cb.id) },
    });
  }
  return out;
}
