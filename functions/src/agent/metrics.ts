import { FieldValue } from "firebase-admin/firestore";
import { org } from "../lib/paths";
import type { Ctx } from "./context";

/**
 * Live operating numbers for the Agent dashboard.
 *  - orgs/{org}/metrics/{YYYY-MM-DD}: per-day counters, added to as events happen (never recomputed).
 *  - orgs/{org}/health/{agent}: when each agent last worked, and its last error.
 * Seeded sample data never passes through here, so every number is real use (live or simulated).
 * Recording a number must never break the work it describes, so every write here swallows its own errors.
 */

export type AgentId =
  | "customer-agent" // ADK: investigator, then classifier (Gemini)
  | "comment-agent" // ADK: comment classifier (Gemini)
  | "policy-engine"
  | "output-guard"
  | "telegram"
  | "whatsapp"
  | "meta-comments"
  | "sweeper";

export const AGENTS: AgentId[] = ["customer-agent", "comment-agent", "policy-engine", "output-guard", "telegram", "whatsapp", "meta-comments", "sweeper"];

/** The UTC day a moment falls in, as the metrics document id. */
export const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

const metricsRef = (ctx: Ctx) => org(ctx.db, ctx.orgId).collection("metrics").doc(dayKey(ctx.now()));
const healthRef = (ctx: Ctx, agent: AgentId) => org(ctx.db, ctx.orgId).collection("health").doc(agent);

/** Adds to today's counters. Field names may use dots for nesting, e.g. "policy.P-07". */
export async function bump(ctx: Ctx, counts: Record<string, number>): Promise<void> {
  const entries = Object.entries(counts).filter(([, n]) => Number.isFinite(n) && n !== 0);
  if (!entries.length) return;
  try {
    const update: Record<string, unknown> = { day: dayKey(ctx.now()), updatedAt: ctx.now() };
    for (const [k, n] of entries) update[k] = FieldValue.increment(n);
    // set+merge creates the day's document; dotted keys would be literal with set, so nest them explicitly.
    await metricsRef(ctx).set(nest(update), { merge: true });
  } catch (e) {
    ctx.log("metrics write failed", { error: (e as Error).message });
  }
}

/** Turns {"policy.P-07": inc} into {policy: {"P-07": inc}} so set+merge nests it. */
function nest(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    const [head, ...rest] = k.split(".");
    if (!rest.length) out[head] = v;
    else out[head] = { ...((out[head] as Record<string, unknown>) ?? {}), [rest.join(".")]: v };
  }
  return out;
}

/** Records that an agent just worked, or just failed. */
export async function health(ctx: Ctx, agent: AgentId, r: { ok: true; detail?: string } | { ok: false; error: string }): Promise<void> {
  try {
    const now = ctx.now();
    await healthRef(ctx, agent).set(
      r.ok
        ? { agent, lastOkAt: now, ...(r.detail ? { lastDetail: r.detail.slice(0, 200) } : {}), okCount: FieldValue.increment(1) }
        : { agent, lastErrorAt: now, lastError: r.error.slice(0, 300), errorCount: FieldValue.increment(1) },
      { merge: true },
    );
  } catch (e) {
    ctx.log("health write failed", { error: (e as Error).message });
  }
}
