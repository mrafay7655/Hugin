// Entry point. Keep this file free of heavy imports: Firebase loads it to discover functions.
import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

export { whatsappWebhook, metaCommentsWebhook, telegramWebhook, onInboundMessage } from "./webhook";
export { sweepStuckMessages } from "./sweep";
export { authBeforeCreate, authBeforeSignIn } from "./auth/blocking";
export * from "./callables";
