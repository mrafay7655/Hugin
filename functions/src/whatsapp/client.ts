/** Thin WhatsApp Cloud API (Graph API) client. */
import { assertMediaSize } from "../lib/text";

export interface WhatsAppCreds {
  token: string;
  phoneNumberId: string;
}

// Pin the Graph API version explicitly and bump it deliberately. Override with GRAPH_API_VERSION.
// GRAPH_API_BASE lets tests point at a local fake of Meta.
const GRAPH = () => `${process.env.GRAPH_API_BASE ?? "https://graph.facebook.com"}/${process.env.GRAPH_API_VERSION ?? "v23.0"}`;

export class WhatsAppError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: unknown) {
    super(message);
  }
}

export async function graphRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GRAPH()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new WhatsAppError(`WhatsApp API ${res.status}: ${json?.error?.message ?? "request failed"}`, res.status, json?.error);
  return json as T;
}

interface SendResponse {
  messages?: { id: string }[];
}

/** E.164 digits only, no plus sign, as WhatsApp expects. */
export const toWaId = (phone: string) => phone.replace(/\D/g, "");

export async function sendText(c: WhatsAppCreds, to: string, body: string): Promise<string> {
  const r = await graphRequest<SendResponse>(`/${c.phoneNumberId}/messages`, c.token, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", to: toWaId(to), type: "text", text: { body, preview_url: false } }),
  });
  return r.messages?.[0]?.id ?? "";
}

/** Up to 3 quick-reply buttons, each title at most 20 characters. */
export async function sendButtons(c: WhatsAppCreds, to: string, body: string, buttons: string[]): Promise<string> {
  const btns = buttons.slice(0, 3).map((title, i) => ({ type: "reply", reply: { id: `btn_${i}`, title: title.slice(0, 20) } }));
  const r = await graphRequest<SendResponse>(`/${c.phoneNumberId}/messages`, c.token, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", to: toWaId(to), type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: btns } } }),
  });
  return r.messages?.[0]?.id ?? "";
}

export async function markRead(c: WhatsAppCreds, messageId: string): Promise<void> {
  await graphRequest(`/${c.phoneNumberId}/messages`, c.token, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }) });
}

/** Resolves a media id to a short-lived URL, then downloads the bytes with the same token. */
export async function downloadMedia(token: string, mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
  const meta = await graphRequest<{ url: string; mime_type: string }>(`/${mediaId}`, token);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new WhatsAppError(`Media download ${res.status}`, res.status);
  assertMediaSize(res.headers.get("content-length"));
  const data = Buffer.from(await res.arrayBuffer());
  assertMediaSize(null, data.byteLength);
  return { data, mimeType: meta.mime_type };
}
