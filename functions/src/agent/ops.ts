import { FieldValue } from "firebase-admin/firestore";
import { alerts, audit, cards, cases, countersDoc, org } from "../lib/paths";
import type { Ctx } from "./context";

/** The bank's own domains, from the organization document. */
export async function officialDomainsOf(ctx: Ctx): Promise<string[]> {
  const d = (await org(ctx.db, ctx.orgId).get()).data()?.officialDomains as string[] | undefined;
  return d?.length ? d : ["ravenwoodbank.com"];
}

/** Append-only audit entry. Security rules deny every update and delete. */
export async function writeAudit(ctx: Ctx, actor: string, action: string, detail: string, value?: string): Promise<void> {
  await audit(ctx.db, ctx.orgId).add({ at: ctx.now(), actor, action, detail, value: value ?? null });
}

/** A short-lived notification the dashboard shows as a toast. */
export async function raiseAlert(ctx: Ctx, tone: "ok" | "err" | "info", text: string, sub?: string): Promise<void> {
  await alerts(ctx.db, ctx.orgId).add({ at: ctx.now(), tone, text, sub: sub ?? null });
}

/** Reversible safety action performed by policy, never by a model-chosen tool. */
export async function lockCard(ctx: Ctx, customerId: string, reason: string): Promise<void> {
  await cards(ctx.db, ctx.orgId).doc(customerId).set({ locked: true, lockedAt: ctx.now(), reason }, { merge: true });
}

/** Allocates the next human-readable case id, e.g. FR-118, atomically. */
export async function openCase(ctx: Ctx, customerId: string, convId: string, priority: "P1" | "P2", summary: string): Promise<string> {
  const counter = countersDoc(ctx.db, ctx.orgId);
  const number = await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(counter);
    const next = ((snap.data()?.fraudCases as number | undefined) ?? 117) + 1;
    tx.set(counter, { fraudCases: next }, { merge: true });
    return next;
  });
  const id = `FR-${number}`;
  await cases(ctx.db, ctx.orgId).doc(id).set({ customerId, convId, priority, summary, status: "open", openedAt: ctx.now() });
  return id;
}

export const serverTs = () => FieldValue.serverTimestamp();
