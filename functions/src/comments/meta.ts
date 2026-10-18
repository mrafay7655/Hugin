import { graphRequest } from "../whatsapp/client";
import type { CommentInput } from "./ingest";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Normalizes Meta comment webhooks into CommentInput. Never throws on odd input.
 *  - Instagram: object "instagram", change field "comments".
 *  - Facebook Page: object "page", change field "feed", item "comment", verb "add".
 */
export function parseMetaComments(payload: unknown, now = Date.now()): CommentInput[] {
  const out: CommentInput[] = [];
  const root = obj(payload);
  for (const entry of arr(root.entry)) {
    for (const change of arr(obj(entry).changes)) {
      const c = obj(change);
      const v = obj(c.value);
      if (root.object === "instagram" && c.field === "comments") {
        const id = str(v.id);
        const text = str(v.text);
        if (!id || !text) continue;
        out.push({
          platform: "instagram", externalId: id, postId: str(obj(v.media).id) || "unknown", postLabel: `Instagram post ${str(obj(v.media).id).slice(-6)}`,
          author: `@${str(obj(v.from).username) || str(obj(v.from).id) || "unknown"}`, text, at: now, parentId: str(v.parent_id) || null,
        });
      } else if (root.object === "page" && c.field === "feed" && v.item === "comment" && v.verb === "add") {
        const id = str(v.comment_id);
        const text = str(v.message);
        if (!id || !text) continue;
        const created = Number(v.created_time);
        out.push({
          platform: "facebook", externalId: id, postId: str(v.post_id) || "unknown", postLabel: `Facebook post ${str(v.post_id).split("_").pop()?.slice(-6)}`,
          author: str(obj(v.from).name) || str(obj(v.from).id) || "unknown", text, at: Number.isFinite(created) && created > 0 ? created * 1000 : now, parentId: str(v.parent_id) || null,
        });
      }
    }
  }
  return out;
}

/** Public reply to a comment. Instagram uses /replies, Facebook uses /comments. */
export async function postCommentReply(token: string, platform: "instagram" | "facebook", commentId: string, message: string): Promise<string> {
  const edge = platform === "instagram" ? "replies" : "comments";
  const r = await graphRequest<{ id?: string }>(`/${commentId}/${edge}`, token, { method: "POST", body: JSON.stringify({ message }) });
  return r.id ?? "";
}

/** Hides a comment from public view (it stays visible to its author). */
export async function setCommentHidden(token: string, platform: "instagram" | "facebook", commentId: string, hidden: boolean): Promise<void> {
  const body = platform === "instagram" ? { hide: hidden } : { is_hidden: hidden };
  await graphRequest(`/${commentId}`, token, { method: "POST", body: JSON.stringify(body) });
}
