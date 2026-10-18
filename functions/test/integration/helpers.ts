import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Ctx } from "../../src/agent/context";
import { processConversation } from "../../src/agent/run";
import { recordInbound } from "../../src/ingest/record";
import { alerts, audit, cards, cases, conversations, messages, traces } from "../../src/lib/paths";
import type { ConversationDoc, MessageDoc, TraceDoc } from "../../src/lib/model";
import type { Channel, MessageKind } from "../../src/types";

export const ORG = "ravenwood";

export function makeCtx(over: Partial<Ctx> = {}): Ctx {
  if (!getApps().length) initializeApp({ projectId: "demo-hugin" });
  return { db: getFirestore(), orgId: ORG, now: () => Date.now(), adk: null, understanderOverride: null, log: () => {}, ...over };
}

export interface SendOpts { viaButton?: boolean; kind?: MessageKind; imageText?: string; voiceSecs?: number; transport?: "sim" | "whatsapp"; at?: number }

/** Records an inbound customer message and lets the agent handle it, like the Firestore trigger does. */
export async function send(ctx: Ctx, customerId: string, channel: Channel, text: string, o: SendOpts = {}) {
  const { convId, msgId } = await recordInbound(ctx, { customerId, channel, transport: o.transport ?? "sim", text, kind: o.kind ?? "text", at: o.at ?? ctx.now(), imageText: o.imageText, voiceSecs: o.voiceSecs, viaButton: o.viaButton });
  await processConversation(ctx, convId);
  return { convId, msgId };
}

export async function snapshot(ctx: Ctx, convId: string) {
  const conv = (await conversations(ctx.db, ctx.orgId).doc(convId).get()).data() as ConversationDoc;
  const msgs = (await messages(ctx.db, ctx.orgId, convId).orderBy("at").get()).docs.map((d) => ({ id: d.id, ...(d.data() as MessageDoc) }));
  const trs = (await traces(ctx.db, ctx.orgId, convId).orderBy("at").get()).docs.map((d) => d.data() as TraceDoc);
  return { conv, msgs, outs: msgs.filter((m) => m.dir === "out"), traces: trs, lastTrace: trs[trs.length - 1] };
}

export const cardLocked = async (ctx: Ctx, customerId: string) => (await cards(ctx.db, ctx.orgId).doc(customerId).get()).data()?.locked === true;
export const allAudit = async (ctx: Ctx) => (await audit(ctx.db, ctx.orgId).get()).docs.map((d) => d.data());
export const allAlerts = async (ctx: Ctx) => (await alerts(ctx.db, ctx.orgId).get()).docs.map((d) => d.data());
export const allCases = async (ctx: Ctx) => (await cases(ctx.db, ctx.orgId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

/** Empties the whole Firestore emulator, so a test file that creates real-looking data cannot leak into the next file. */
export async function clearFirestore(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  const res = await fetch(`http://${host}/emulator/v1/projects/demo-hugin/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`could not clear the emulator: ${res.status}`);
}
