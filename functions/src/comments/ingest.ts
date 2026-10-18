import { FieldValue } from "firebase-admin/firestore";
import { composeCommentReply } from "./replies";
import { classifyComment, mergeClassification, type CommentClassification } from "./classify";
import { raiseAlert } from "../agent/ops";
import { bump, health } from "../agent/metrics";
import { retrieveFromDocs, type KbDoc } from "../agent/retrieve";
import type { Ctx } from "../agent/context";
import { comments, kb as kbCol, org, posts } from "../lib/paths";

export type CommentPlatform = "instagram" | "facebook" | "youtube" | "x" | "tiktok";

/** What a post is for. Used to group and filter comments. A post with no campaign shows as "Uncategorised". */
export const CAMPAIGNS = ["Product launch", "Security awareness", "Education", "Competitor", "Support"] as const;
export type Campaign = (typeof CAMPAIGNS)[number];

export interface CommentInput {
  platform: CommentPlatform;
  /** The platform's own comment id. With the platform, it is the idempotency key. */
  externalId: string;
  postId: string;
  postLabel?: string;
  postUrl?: string;
  /** Only written when given, so a campaign a manager chose is never overwritten by a later comment. */
  postCampaign?: Campaign;
  author: string;
  text: string;
  at: number;
  parentId?: string | null;
  sample?: boolean;
  /** Seeded sample, typed into the demo tools, or a real comment from Meta. Defaults from `sample`. */
  origin?: "sample" | "simulated" | "live";
}

export interface CommentDoc extends Omit<CommentClassification, "urls"> {
  platform: CommentPlatform;
  externalId: string;
  postId: string;
  postLabel: string;
  author: string;
  text: string;
  at: number;
  parentId: string | null;
  urls: string[];
  status: "new" | "handled" | "hidden";
  /** A suggested public reply. A person reviews it; nothing is posted automatically. */
  draft: string | null;
  draftCite: { doc: string; section: string } | null;
  suggestHide: boolean;
  sample: boolean;
  origin?: "sample" | "simulated" | "live";
  reply?: { text: string; by: string; at: number } | null;
}

export const commentId = (platform: string, externalId: string) => `${platform}_${externalId}`;
export const postKey = (platform: string, postId: string) => `${platform}_${postId}`;

async function officialDomains(ctx: Ctx): Promise<string[]> {
  return ((await org(ctx.db, ctx.orgId).get()).data()?.officialDomains as string[] | undefined) ?? ["ravenwoodbank.com"];
}

/**
 * Classifies and stores one public comment, and updates the post's sentiment rollup.
 * Idempotent: Meta retries and pollers re-reading the same comment do nothing the second time.
 */
export async function ingestComment(ctx: Ctx, input: CommentInput): Promise<{ id: string; created: boolean; doc: CommentDoc | null }> {
  const id = commentId(input.platform, input.externalId);
  const ref = comments(ctx.db, ctx.orgId).doc(id);
  if ((await ref.get()).exists) return { id, created: false, doc: null };

  const domains = await officialDomains(ctx);
  const rules = classifyComment(input.text, domains);
  let cls = rules;
  let modelError: string | null = null;
  if (ctx.commentClassifier) {
    try {
      cls = mergeClassification(await ctx.commentClassifier(input.text), rules);
    } catch (e) {
      modelError = (e as Error).message;
      ctx.log("comment model failed, using rules", { error: modelError });
    }
  }
  const origin = input.origin ?? (input.sample ? "sample" : "live");

  const kbDocs = (await kbCol(ctx.db, ctx.orgId).get()).docs.map((d) => ({ id: d.id, ...(d.data() as Omit<KbDoc, "id">) }));
  const retrieval = cls.intent === "question" ? retrieveFromDocs(input.text, kbDocs) : null;
  const reply = composeCommentReply({ classification: cls, retrieval, officialDomain: domains[0], author: input.author });

  const doc: CommentDoc = {
    ...cls,
    platform: input.platform, externalId: input.externalId, postId: input.postId, postLabel: input.postLabel ?? input.postId,
    author: input.author, text: input.text, at: input.at, parentId: input.parentId ?? null,
    status: "new", draft: reply?.text ?? null, draftCite: reply?.cite ?? null,
    // Scams and abuse are hidden. A complaint or legal threat is not: hiding it would look like silencing a customer.
    suggestHide: cls.intent === "scam_or_spam" || (cls.toxicity >= 0.6 && !/legal|regulat/i.test(cls.riskReason ?? "")), sample: input.sample ?? false, origin,
  };

  try {
    await ref.create(doc);
  } catch (e) {
    if ((e as { code?: number }).code === 6) return { id, created: false, doc: null }; // lost a race with a retry
    throw e;
  }

  await posts(ctx.db, ctx.orgId).doc(postKey(input.platform, input.postId)).set(
    {
      platform: input.platform, postId: input.postId, label: input.postLabel ?? input.postId, url: input.postUrl ?? null, lastAt: input.at,
      ...(input.postCampaign ? { campaign: input.postCampaign } : {}),
      total: FieldValue.increment(1), [cls.sentiment]: FieldValue.increment(1), scoreSum: FieldValue.increment(cls.score),
      needsReply: FieldValue.increment(cls.needsReply ? 1 : 0), risk: FieldValue.increment(cls.riskFlag ? 1 : 0), sample: input.sample ?? false,
    },
    { merge: true },
  );

  // Seeded sample comments are not real use, so they do not count on the Agent dashboard.
  if (origin !== "sample") {
    await bump(ctx, {
      comments: 1,
      [origin === "live" ? "commentsLive" : "commentsSimulated"]: 1,
      [cls.source === "gemini" ? "commentsByGemini" : "commentsByRules"]: 1,
      commentsRisky: cls.riskFlag ? 1 : 0,
      commentModelErrors: modelError ? 1 : 0,
    });
    await health(ctx, "comment-agent", modelError
      ? { ok: false, error: `Gemini unavailable, rules used instead: ${modelError}` }
      : { ok: true, detail: `${cls.source === "gemini" ? "Gemini" : "rules only"} · ${cls.sentiment} · ${cls.intent}` });
  }

  if (cls.riskFlag && !input.sample) {
    await raiseAlert(ctx, "err", `Risky comment on ${input.platform}`, `${input.author}: ${cls.riskReason}`);
  }
  return { id, created: true, doc };
}
