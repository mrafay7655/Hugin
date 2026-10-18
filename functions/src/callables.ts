import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";
import { z } from "zod";
import * as A from "./actions/manager";
import { ActionError, type Actor } from "./actions/manager";
import { OutboundBlocked } from "./agent/outbound";
import { CAMPAIGNS } from "./comments/ingest";
import { WARM_INSTANCES, makeCtx, META_PAGE_TOKEN, ORG_ID, REGION, TELEGRAM_BOT_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN } from "./runtime";

/**
 * Every callable requires a signed-in member of this organization. A manager may do anything.
 * A judge may only call the actions marked `judge: true`, and those act on simulated data only.
 */
async function requireMember(req: CallableRequest<unknown>, allowJudge: boolean): Promise<Actor> {
  const t = req.auth?.token;
  if (!req.auth || !t) throw new HttpsError("unauthenticated", "Sign in first.");
  const role = t.role === "manager" || t.role === "judge" ? t.role : null;
  if (t.orgId !== ORG_ID.value() || !role) throw new HttpsError("permission-denied", "Your account does not have access to this workspace.");
  if (role === "judge" && !allowJudge) throw new HttpsError("permission-denied", "Judges can look around and try the demo, but cannot change settings, knowledge or access.");
  // A removed person's token stays valid for up to an hour. The member record is what ends their access at once.
  const member = await getFirestore().doc(`orgs/${t.orgId}/members/${req.auth.uid}`).get();
  if (member.data()?.revoked === true) throw new HttpsError("permission-denied", "Your access to this workspace was removed.");
  return {
    uid: req.auth.uid,
    role,
    name: (t.name as string | undefined) ?? (t.email as string | undefined) ?? "Manager",
    email: (t.email as string | undefined) ?? req.auth.uid,
  };
}

/** Maps domain errors to client-friendly HttpsErrors. Unknown errors are logged and hidden. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e instanceof ActionError) throw new HttpsError(e.code, e.message);
    if (e instanceof OutboundBlocked) throw new HttpsError("failed-precondition", e.message, { reason: e.reason });
    if (e instanceof z.ZodError) throw new HttpsError("invalid-argument", e.issues[0]?.message ?? "Invalid input");
    console.error("callable failed", e);
    throw new HttpsError("internal", "Something went wrong. Please try again.");
  }
}

const opts = { region: REGION, secrets: [WHATSAPP_TOKEN, META_PAGE_TOKEN, TELEGRAM_BOT_TOKEN] };
const ctxFor = () => makeCtx({ withWhatsApp: !!WHATSAPP_PHONE_NUMBER_ID.value(), withMeta: true, withTelegram: true });

const str = (max = 4000) => z.string().max(max);
const Id = z.object({ convId: str(200).min(1) });

/** Wraps an action: authenticate, validate input, run, map errors. */
function manager<S extends z.ZodTypeAny, R>(schema: S, fn: (ctx: ReturnType<typeof ctxFor>, actor: Actor, input: z.infer<S>) => Promise<R>, extra: { timeoutSeconds?: number; memory?: "256MiB" | "512MiB" | "1GiB"; minInstances?: number; judge?: boolean } = {}) {
  const { judge = false, ...runtime } = extra;
  return onCall({ ...opts, ...runtime }, (req) =>
    run(async () => {
      const actor = await requireMember(req, judge);
      return fn(ctxFor(), actor, schema.parse(req.data ?? {}));
    }),
  );
}

export const approveDraft = manager(Id.extend({ text: str().optional() }), A.approveDraft, { judge: true });
export const rejectDraft = manager(Id.extend({ reason: str(300).optional() }), A.rejectDraft, { judge: true });
export const sendHumanMessage = manager(Id.extend({ text: str().min(1) }), A.sendHuman, { judge: true });
export const setConversationMode = manager(Id.extend({ human: z.boolean() }), A.setMode, { judge: true });
export const resolveConversation = manager(Id, A.resolveConversation, { judge: true });
export const escalateToFraud = manager(Id, A.escalateToFraud, { judge: true });
export const unlockCard = manager(Id, A.unlockCard, { judge: true });
export const updatePolicy = manager(z.unknown(), (c, a, i) => A.updatePolicy(c, a, i));
export const addKnowledgeDoc = manager(z.object({ title: str(200), text: str(6000) }), A.addKbDoc);
export const setKnowledgeStatus = manager(z.object({ docId: str(200).min(1), status: z.enum(["active", "retired"]) }), A.setKbStatus);
export const addAllowedDomain = manager(z.object({ domain: str(253) }), A.addAllowedDomain);
export const removeAllowedDomain = manager(z.object({ domain: str(253) }), A.removeAllowedDomain);
export const addInvite = manager(z.object({ email: str(320), role: z.enum(["manager", "judge"]).optional() }), A.addInvite);
export const removeInvite = manager(z.object({ email: str(320) }), A.removeInvite);
export const simulateInbound = manager(z.unknown(), (c, a, i) => A.simulateInbound(c, a, i), { judge: true, minInstances: WARM_INSTANCES });
// Reset re-seeds the comments through Gemini, one call per comment, so it needs more than the 60 second default.
export const resetDemo = manager(z.unknown(), (c, a) => A.resetDemo(c, a), { timeoutSeconds: 300, memory: "512MiB" });
export const replyToComment = manager(z.object({ commentId: str(200).min(1), text: str(1000) }), A.replyToComment, { judge: true });
export const hideComment = manager(z.object({ commentId: str(200).min(1), hidden: z.boolean() }), A.hideComment, { judge: true });
export const setPostCampaign = manager(z.object({ postKey: str(300).min(1), campaign: z.enum(["", ...CAMPAIGNS]) }), A.setPostCampaign);
export const handleComment = manager(z.object({ commentId: str(200).min(1) }), A.handleComment, { judge: true });
// Kept warm: the comment test on Try it live calls Gemini while the judge waits.
export const simulateComment = manager(z.unknown(), (c, a, i) => A.simulateComment(c, a, i), { judge: true, minInstances: WARM_INSTANCES });
export const clearSandbox = manager(z.unknown(), (c, a) => A.clearSandbox(c, a), { judge: true });
