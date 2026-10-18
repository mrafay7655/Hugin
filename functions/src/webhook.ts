import { timingSafeEqual } from "node:crypto";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { handleWhatsAppEvents } from "./ingest/whatsapp";
import { processConversation } from "./agent/run";
import type { MessageDoc } from "./lib/model";
import { ingestComment } from "./comments/ingest";
import { parseMetaComments } from "./comments/meta";
import { makeCtx, REGION, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN } from "./runtime";
import { handleTelegramEvents } from "./ingest/telegram";
import { answerCallback } from "./telegram/client";
import { parseTelegramUpdate } from "./telegram/parse";
import { parseWebhook } from "./whatsapp/parse";
import { verifySignature } from "./whatsapp/signature";
import { bump, health } from "./agent/metrics";
import { WARM_INSTANCES } from "./runtime";

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Meta's webhook endpoint.
 *  GET  : one-time subscription handshake (hub.challenge).
 *  POST : message and status deliveries, authenticated by X-Hub-Signature-256.
 * It only stores events. The agent runs separately, from the message-document trigger,
 * so Meta always gets a fast answer and a retried delivery is harmless (idempotent).
 */
export const whatsappWebhook = onRequest(
  { region: REGION, secrets: [WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN], memory: "512MiB", timeoutSeconds: 30, cors: false },
  async (req, res) => {
    if (req.method === "GET") {
      const mode = String(req.query["hub.mode"] ?? "");
      const token = String(req.query["hub.verify_token"] ?? "");
      const challenge = String(req.query["hub.challenge"] ?? "");
      if (mode === "subscribe" && challenge && safeEqual(token, WHATSAPP_VERIFY_TOKEN.value())) {
        res.status(200).type("text/plain").send(challenge);
      } else {
        res.status(403).send("Forbidden");
      }
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const raw = req.rawBody;
    if (!raw || !verifySignature(raw, req.header("x-hub-signature-256"), WHATSAPP_APP_SECRET.value())) {
      logger.warn("webhook signature rejected", { ip: req.ip });
      await bump(makeCtx(), { "rejected.whatsapp": 1 });
      res.status(401).send("Invalid signature");
      return;
    }

    try {
      // Only messages sent to OUR number. A signed payload for another number on the same Meta app is not ours to answer.
      const ours = WHATSAPP_PHONE_NUMBER_ID.value();
      const all = parseWebhook(JSON.parse(raw.toString("utf8")));
      const events = all.filter((e) => e.kind === "status" || !ours || e.phoneNumberId === ours);
      if (events.length < all.length) logger.warn("ignored WhatsApp messages for another phone number", { dropped: all.length - events.length });
      const ctx = makeCtx();
      const result = await handleWhatsAppEvents(ctx, events);
      logger.info("webhook handled", result);
      await bump(ctx, { "received.whatsapp": result.stored, "statuses.whatsapp": result.statuses });
      await health(ctx, "whatsapp", { ok: true, detail: `${result.stored} message(s), ${result.statuses} status update(s)` });
      res.status(200).send("OK");
    } catch (e) {
      // A 5xx makes Meta retry. Safe because ingestion is idempotent.
      logger.error("webhook failed", e);
      await health(makeCtx(), "whatsapp", { ok: false, error: `Webhook failed: ${(e as Error).message}` });
      res.status(500).send("Error");
    }
  },
);

/** Runs the agent whenever a customer message is stored, from the webhook or from the demo simulator. */
export const onInboundMessage = onDocumentCreated(
  // One warm instance during judging: a cold start plus the first Gemini connection costs 10+ seconds.
  { document: "orgs/{orgId}/conversations/{convId}/messages/{msgId}", region: REGION, secrets: [WHATSAPP_TOKEN, TELEGRAM_BOT_TOKEN], memory: "1GiB", timeoutSeconds: 180, minInstances: WARM_INSTANCES },
  async (event) => {
    const msg = event.data?.data() as MessageDoc | undefined;
    // Only brand-new customer messages. Seeded or already-handled history has processed === true.
    if (!msg || msg.dir !== "in" || msg.author !== "customer" || msg.processed !== false) return;
    const ctx = { ...makeCtx({ withWhatsApp: !!WHATSAPP_PHONE_NUMBER_ID.value(), withTelegram: true }), orgId: event.params.orgId };
    await processConversation(ctx, event.params.convId);
  },
);

/**
 * Instagram and Facebook Page comment webhooks (same Meta app, same signature scheme).
 * Each comment is classified for sentiment and risk and stored; ingestion is idempotent.
 */
export const metaCommentsWebhook = onRequest(
  { region: REGION, secrets: [WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN], memory: "512MiB", timeoutSeconds: 60, cors: false },
  async (req, res) => {
    if (req.method === "GET") {
      const ok = req.query["hub.mode"] === "subscribe" && safeEqual(String(req.query["hub.verify_token"] ?? ""), WHATSAPP_VERIFY_TOKEN.value());
      if (ok) res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
      else res.status(403).send("Forbidden");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const raw = req.rawBody;
    if (!raw || !verifySignature(raw, req.header("x-hub-signature-256"), WHATSAPP_APP_SECRET.value())) {
      logger.warn("comments webhook signature rejected", { ip: req.ip });
      await bump(makeCtx(), { "rejected.meta": 1 });
      res.status(401).send("Invalid signature");
      return;
    }
    try {
      const inputs = parseMetaComments(JSON.parse(raw.toString("utf8")));
      const ctx = makeCtx();
      let created = 0;
      for (const input of inputs) if ((await ingestComment(ctx, input)).created) created++;
      logger.info("comments webhook handled", { received: inputs.length, created });
      await health(ctx, "meta-comments", { ok: true, detail: `${created} new comment(s)` });
      res.status(200).send("OK");
    } catch (e) {
      logger.error("comments webhook failed", e);
      await health(makeCtx(), "meta-comments", { ok: false, error: `Webhook failed: ${(e as Error).message}` });
      res.status(500).send("Error");
    }
  },
);

/**
 * Telegram bot webhook. Telegram echoes the secret chosen at setWebhook time in the
 * X-Telegram-Bot-Api-Secret-Token header, so the header is the authentication.
 * Like the WhatsApp webhook it only stores events; the agent runs from the message-document trigger.
 */
export const telegramWebhook = onRequest(
  { region: REGION, secrets: [TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN], memory: "512MiB", timeoutSeconds: 30, cors: false, minInstances: WARM_INSTANCES },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const given = req.header("x-telegram-bot-api-secret-token") ?? "";
    const expected = TELEGRAM_WEBHOOK_SECRET.value();
    if (!expected || !safeEqual(given, expected)) {
      logger.warn("telegram webhook secret rejected", { ip: req.ip });
      await bump(makeCtx(), { "rejected.telegram": 1 });
      res.status(401).send("Invalid secret");
      return;
    }
    try {
      const events = parseTelegramUpdate(req.body);
      const ctx = makeCtx({ withTelegram: true });
      const result = await handleTelegramEvents(ctx, events);
      await bump(ctx, { "received.telegram": result.stored, "limited.telegram": result.limited });
      await health(ctx, "telegram", { ok: true, detail: `${result.stored} message(s)${result.limited ? `, ${result.limited} over the limit` : ""}` });
      // Stop the spinner on tapped buttons. Never let this fail the delivery.
      const token = TELEGRAM_BOT_TOKEN.value();
      for (const e of events) if (e.body.type === "button_reply") await answerCallback({ token }, e.body.callbackId).catch(() => undefined);
      logger.info("telegram webhook handled", result);
      res.status(200).send("OK");
    } catch (e) {
      // A 5xx makes Telegram retry. Safe because ingestion is idempotent.
      logger.error("telegram webhook failed", (e as Error).message);
      await health(makeCtx(), "telegram", { ok: false, error: `Webhook failed: ${(e as Error).message}` });
      res.status(500).send("Error");
    }
  },
);
