/** Normalizes a WhatsApp Cloud API webhook payload into flat events. Never throws on odd input. */

export type InboundBody =
  | { type: "text"; text: string }
  | { type: "audio"; mediaId: string; mimeType: string; voice: boolean }
  | { type: "image"; mediaId: string; mimeType: string; caption: string }
  | { type: "button_reply"; id: string; title: string }
  | { type: "unsupported"; raw: string };

export interface InboundMessageEvent {
  kind: "message";
  /** WhatsApp message id (wamid). The idempotency key. */
  id: string;
  /** Sender's WhatsApp id (phone number without "+"). */
  from: string;
  profileName: string;
  /** Epoch milliseconds. */
  at: number;
  phoneNumberId: string;
  body: InboundBody;
}

export interface StatusEvent {
  kind: "status";
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipient: string;
  at: number;
  error?: string;
}

export type WhatsAppEvent = InboundMessageEvent | StatusEvent;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ms = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
};

function parseBody(m: Json): InboundBody {
  const type = str(m.type);
  if (type === "text") return { type: "text", text: str(obj(m.text).body) };
  if (type === "audio") {
    const a = obj(m.audio);
    return { type: "audio", mediaId: str(a.id), mimeType: str(a.mime_type) || "audio/ogg", voice: a.voice === true };
  }
  if (type === "image") {
    const i = obj(m.image);
    return { type: "image", mediaId: str(i.id), mimeType: str(i.mime_type) || "image/jpeg", caption: str(i.caption) };
  }
  if (type === "interactive") {
    const r = obj(obj(m.interactive).button_reply);
    if (str(r.title)) return { type: "button_reply", id: str(r.id), title: str(r.title) };
  }
  if (type === "button") {
    const b = obj(m.button);
    if (str(b.text)) return { type: "button_reply", id: str(b.payload), title: str(b.text) };
  }
  return { type: "unsupported", raw: type || "unknown" };
}

export function parseWebhook(payload: unknown): WhatsAppEvent[] {
  const events: WhatsAppEvent[] = [];
  const root = obj(payload);
  if (root.object !== "whatsapp_business_account") return events;
  for (const entry of arr(root.entry)) {
    for (const change of arr(obj(entry).changes)) {
      const c = obj(change);
      if (c.field !== "messages") continue;
      const value = obj(c.value);
      const phoneNumberId = str(obj(value.metadata).phone_number_id);
      const names = new Map<string, string>();
      for (const ct of arr(value.contacts)) names.set(str(obj(ct).wa_id), str(obj(obj(ct).profile).name));

      for (const raw of arr(value.messages)) {
        const m = obj(raw);
        if (!str(m.id) || !str(m.from)) continue;
        events.push({ kind: "message", id: str(m.id), from: str(m.from), profileName: names.get(str(m.from)) ?? "", at: ms(m.timestamp), phoneNumberId, body: parseBody(m) });
      }
      for (const raw of arr(value.statuses)) {
        const s = obj(raw);
        const status = str(s.status);
        if (!str(s.id) || !["sent", "delivered", "read", "failed"].includes(status)) continue;
        const err = obj(arr(s.errors)[0]);
        events.push({
          kind: "status", id: str(s.id), status: status as StatusEvent["status"], recipient: str(s.recipient_id), at: ms(s.timestamp),
          error: str(err.title) || (err.code ? String(err.code) : undefined),
        });
      }
    }
  }
  return events;
}
