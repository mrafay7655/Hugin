import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/whatsapp/signature";
import { parseWebhook } from "../src/whatsapp/parse";

const SECRET = "app-secret-123";

/** Shapes follow the WhatsApp Cloud API webhook format. */
const wrap = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA_ID", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550100199", phone_number_id: "PNID" }, ...value } }] }],
});
const contacts = [{ profile: { name: "Marcus Reed" }, wa_id: "14155550142" }];

describe("signature", () => {
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  it("accepts a correct signature", () => expect(verifySignature(body, signBody(body, SECRET), SECRET)).toBe(true));
  it("rejects a wrong secret", () => expect(verifySignature(body, signBody(body, "other"), SECRET)).toBe(false));
  it("rejects a tampered body", () => expect(verifySignature(Buffer.from('{"hello":"w0rld"}'), signBody(body, SECRET), SECRET)).toBe(false));
  it("rejects missing, malformed and wrong-scheme headers", () => {
    for (const h of [undefined, "", "sha256=", "sha256=zz", "sha1=" + "a".repeat(40), "garbage", "sha256=abcd"]) {
      expect(verifySignature(body, h, SECRET)).toBe(false);
    }
  });
  it("rejects when no secret is configured", () => expect(verifySignature(body, signBody(body, ""), "")).toBe(false));
  it("is computed over raw bytes, so whitespace matters", () => {
    const pretty = Buffer.from('{ "hello": "world" }');
    expect(verifySignature(pretty, signBody(body, SECRET), SECRET)).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("parses a text message", () => {
    const ev = parseWebhook(wrap({ contacts, messages: [{ from: "14155550142", id: "wamid.A", timestamp: "1760000000", type: "text", text: { body: "Hi" } }] }));
    expect(ev).toEqual([{ kind: "message", id: "wamid.A", from: "14155550142", profileName: "Marcus Reed", at: 1760000000000, phoneNumberId: "PNID", body: { type: "text", text: "Hi" } }]);
  });

  it("parses a voice note and flags it as voice", () => {
    const [e] = parseWebhook(wrap({ contacts, messages: [{ from: "1", id: "wamid.V", timestamp: "1", type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus", voice: true } }] }));
    expect(e).toMatchObject({ kind: "message", body: { type: "audio", mediaId: "MEDIA1", voice: true, mimeType: "audio/ogg; codecs=opus" } });
  });

  it("parses an image with a caption", () => {
    const [e] = parseWebhook(wrap({ contacts, messages: [{ from: "1", id: "wamid.I", timestamp: "1", type: "image", image: { id: "MEDIA2", mime_type: "image/jpeg", caption: "is this real?" } }] }));
    expect(e).toMatchObject({ body: { type: "image", mediaId: "MEDIA2", caption: "is this real?" } });
  });

  it("parses an interactive button reply", () => {
    const [e] = parseWebhook(wrap({ contacts, messages: [{ from: "1", id: "wamid.B", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "btn_1", title: "Yes, I did" } } }] }));
    expect(e).toMatchObject({ body: { type: "button_reply", title: "Yes, I did" } });
  });

  it("parses delivery statuses, including failures", () => {
    const ev = parseWebhook(wrap({ statuses: [
      { id: "wamid.X", status: "delivered", timestamp: "5", recipient_id: "1" },
      { id: "wamid.Y", status: "failed", timestamp: "6", recipient_id: "1", errors: [{ code: 131047, title: "Re-engagement message" }] },
      { id: "wamid.Z", status: "weird", timestamp: "6", recipient_id: "1" },
    ] }));
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ kind: "status", status: "delivered" });
    expect(ev[1]).toMatchObject({ status: "failed", error: "Re-engagement message" });
  });

  it("marks unknown message types as unsupported instead of throwing", () => {
    const [e] = parseWebhook(wrap({ contacts, messages: [{ from: "1", id: "wamid.S", timestamp: "1", type: "sticker" }] }));
    expect(e).toMatchObject({ body: { type: "unsupported", raw: "sticker" } });
  });

  it("handles several messages in one delivery", () => {
    const ev = parseWebhook(wrap({ contacts, messages: [
      { from: "1", id: "a", timestamp: "1", type: "text", text: { body: "one" } },
      { from: "1", id: "b", timestamp: "2", type: "text", text: { body: "two" } },
    ] }));
    expect(ev.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it.each([null, undefined, "x", 5, {}, { object: "page" }, { object: "whatsapp_business_account", entry: "no" }, { object: "whatsapp_business_account", entry: [{ changes: [{ field: "other" }] }] }])(
    "returns nothing for garbage input %#", (input) => expect(parseWebhook(input)).toEqual([]),
  );
});
