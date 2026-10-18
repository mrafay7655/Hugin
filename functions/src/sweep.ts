import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { processConversation } from "./agent/run";
import { bump, health } from "./agent/metrics";
import { makeCtx, REGION, TELEGRAM_BOT_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN } from "./runtime";

/** A message still unhandled this long after it arrived means its run was lost (timeout, crash). */
export const STUCK_AFTER_MS = 4 * 60 * 1000;

/**
 * Every few minutes, picks up customer messages the agent never finished. Without this, a function that
 * timed out mid-message would leave that customer unanswered until they wrote again.
 * Safe to overlap with a live run: the per-conversation lease lets only one run proceed.
 */
export const sweepStuckMessages = onSchedule(
  { schedule: "every 5 minutes", region: REGION, secrets: [WHATSAPP_TOKEN, TELEGRAM_BOT_TOKEN], memory: "1GiB", timeoutSeconds: 240 },
  async () => {
    const ctx = makeCtx({ withWhatsApp: !!WHATSAPP_PHONE_NUMBER_ID.value(), withTelegram: true });
    const stuck = await ctx.db.collectionGroup("messages").where("processed", "==", false).where("at", "<", ctx.now() - STUCK_AFTER_MS).limit(20).get();
    const convs = new Set<string>();
    for (const d of stuck.docs) {
      // orgs/{org}/conversations/{conv}/messages/{msg}
      const parts = d.ref.path.split("/");
      if (parts[0] === "orgs" && parts[1] === ctx.orgId) convs.add(parts[3]);
    }
    for (const convId of convs) {
      try {
        await processConversation(ctx, convId);
      } catch (e) {
        logger.error("sweep failed for a conversation", { convId, error: (e as Error).message });
      }
    }
    if (convs.size) logger.info("sweep picked up stuck conversations", { count: convs.size });
    await bump(ctx, { sweptConversations: convs.size });
    await health(ctx, "sweeper", { ok: true, detail: convs.size ? `picked up ${convs.size} stuck conversation(s)` : "nothing stuck" });
  },
);
