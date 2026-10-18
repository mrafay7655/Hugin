import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import { defineSecret, defineString } from "firebase-functions/params";
import type { Ctx } from "./agent/context";
import { adkConfigFromEnv } from "./agent/adk/config";
import { createAdkCommentClassifier } from "./agent/adk/factory";

if (!getApps().length) initializeApp();

/** Secrets live in Google Secret Manager. Nothing sensitive is in the repo or in env files. */
export const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
export const WHATSAPP_APP_SECRET = defineSecret("WHATSAPP_APP_SECRET");
export const WHATSAPP_VERIFY_TOKEN = defineSecret("WHATSAPP_VERIFY_TOKEN");
/** Telegram bot token (from @BotFather) and the secret Telegram echoes back in a header on every webhook call. */
export const TELEGRAM_BOT_TOKEN = defineSecret("TELEGRAM_BOT_TOKEN");
export const TELEGRAM_WEBHOOK_SECRET = defineSecret("TELEGRAM_WEBHOOK_SECRET");
/** Page access token (Facebook Page and linked Instagram account) for replying to and hiding comments. */
export const META_PAGE_TOKEN = defineSecret("META_PAGE_TOKEN");
/** Not secret: an identifier. */
export const WHATSAPP_PHONE_NUMBER_ID = defineString("WHATSAPP_PHONE_NUMBER_ID", { default: "" });
export const ORG_ID = defineString("ORG_ID", { default: "ravenwood" });

export const REGION = "us-central1";

/**
 * Instances kept warm for the agent and the live comment test, read when deploying. 0 by default.
 * Set HUGIN_WARM_INSTANCES=1 in functions/.env.<project> to remove cold starts for judges; it raises the
 * monthly bill (Firebase then asks for `firebase deploy --force`).
 */
export const WARM_INSTANCES = Math.max(0, Math.min(3, Number(process.env.HUGIN_WARM_INSTANCES) || 0));

// On a real, warm instance (K_SERVICE is set only when running), open the Gemini connection now.
if (WARM_INSTANCES > 0 && process.env.K_SERVICE) {
  const cfg = adkConfigFromEnv();
  if (cfg) void import("./agent/adk/model").then((m) => m.prewarmGemini(cfg));
}

/** Builds the runtime context for one invocation. Secrets are read here, never at module load. */
export function makeCtx(opts: { withWhatsApp?: boolean; withMeta?: boolean; withTelegram?: boolean } = {}): Ctx {
  const token = opts.withWhatsApp ? WHATSAPP_TOKEN.value() : "";
  const phoneNumberId = opts.withWhatsApp ? WHATSAPP_PHONE_NUMBER_ID.value() : "";
  const telegramToken = opts.withTelegram ? TELEGRAM_BOT_TOKEN.value() : "";
  let bucket: Ctx["bucket"];
  try {
    bucket = getStorage().bucket();
  } catch {
    bucket = undefined; // Storage not set up yet: media is still analysed, just not archived
  }
  return {
    db: getFirestore(),
    orgId: ORG_ID.value(),
    bucket,
    now: () => Date.now(),
    whatsapp: token && phoneNumberId ? { token, phoneNumberId } : undefined,
    telegram: telegramToken ? { token: telegramToken } : undefined,
    adk: adkConfigFromEnv(),
    commentClassifier: createAdkCommentClassifier(adkConfigFromEnv()),
    metaPageToken: opts.withMeta ? META_PAGE_TOKEN.value() || undefined : undefined,
    accounts: {
      uidByEmail: async (email) => getAuth().getUserByEmail(email).then((u) => u.uid, () => null),
      uidsByDomain: async (domain) => {
        const out: string[] = [];
        let token: string | undefined;
        do {
          const page = await getAuth().listUsers(1000, token);
          for (const u of page.users) if (u.email?.toLowerCase().endsWith(`@${domain}`)) out.push(u.uid);
          token = page.pageToken;
        } while (token);
        return out;
      },
      revoke: async (uid) => {
        await getAuth().setCustomUserClaims(uid, null);
        await getAuth().revokeRefreshTokens(uid);
      },
    },
    log: (msg, data) => logger.info(msg, data),
  };
}
