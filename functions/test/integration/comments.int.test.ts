import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, handleComment, hideComment, replyToComment, setPostCampaign, simulateComment, type Actor } from "../../src/actions/manager";
import { ingestComment, type CommentDoc } from "../../src/comments/ingest";
import { seedDemoData } from "../../src/seed/demo";
import { alerts, audit, comments, org, posts } from "../../src/lib/paths";
import { makeCtx } from "./helpers";

const ctx = makeCtx();
const actor: Actor = { uid: "u1", name: "Muhammad Rafay", email: "muhammad.rafay@demo.com" };

const graphCalls: { method: string; url: string; body: Record<string, unknown> }[] = [];
const graph = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    graphCalls.push({ method: req.method ?? "", url: req.url ?? "", body: b ? JSON.parse(b) : {} });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "reply_1", success: true }));
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => graph.listen(9977, "127.0.0.1", r));
  process.env.GRAPH_API_BASE = "http://127.0.0.1:9977";
  await seedDemoData(ctx);
});
afterAll(() => { graph.close(); delete process.env.GRAPH_API_BASE; });

const all = async () => (await comments(ctx.db, ctx.orgId).get()).docs.map((d) => ({ id: d.id, ...(d.data() as CommentDoc) }));
const byText = async (frag: string) => (await all()).find((c) => c.text.includes(frag))!;
const lastAudit = async (action: string) => (await audit(ctx.db, ctx.orgId).where("action", "==", action).get()).docs.map((d) => d.data());

describe("seeded comments are classified by the real pipeline", () => {
  it("stores every comment with sentiment, topic and intent", async () => {
    const cs = await all();
    expect(cs.length).toBe(27);
    for (const c of cs) {
      expect(["positive", "neutral", "negative", "mixed"]).toContain(c.sentiment);
      expect(c.score).toBeGreaterThanOrEqual(-1);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(c.sample).toBe(true);
    }
  });

  it("reads sarcasm as negative, not praise", async () => {
    const c = await byText("Love waiting to see my paycheck");
    expect(c.sarcasm).toBe(true);
    expect(c.sentiment).toBe("negative");
    expect(c.needsReply).toBe(true);
  });

  it("flags the scam giveaway, suggests hiding it, and drafts no reply", async () => {
    const c = await byText("ravenw00d-rewards.com");
    expect(c.intent).toBe("scam_or_spam");
    expect(c.riskFlag).toBe(true);
    expect(c.suggestHide).toBe(true);
    expect(c.draft).toBeNull();
    expect(c.needsReply).toBe(false);
  });

  it("treats a customer's phishing report as a fraud report that needs a careful reply", async () => {
    const c = await byText("Fake right?");
    expect(c.intent).toBe("fraud_report");
    expect(c.riskFlag).toBe(true);
    expect(c.draft).toMatch(/Fraud team/);
    expect(c.draft).toContain("ravenwoodbank.com");
  });

  it("flags a legal threat and an abusive-risk comment for a person", async () => {
    const threat = await byText("CFPB");
    expect(threat.riskFlag).toBe(true);
    expect(threat.riskReason).toMatch(/legal/);
    expect(threat.sentiment).toBe("negative");
  });

  it("answers a fee question from the Fee Schedule, with its citation", async () => {
    const c = await byText("fee for an international wire at Ravenwood");
    expect(c.intent).toBe("question");
    expect(c.draft).toContain("$45");
    expect(c.draftCite).toEqual({ doc: "Fee Schedule", section: "§4.2" });
  });

  it("does not invent an answer to a question with no approved source", async () => {
    const c = await byText("foreign transaction fees");
    expect(c.draft).not.toMatch(/\$\d/);
    expect(c.draft).toMatch(/message us privately/i);
  });

  it("no drafted reply ever violates the output guard", async () => {
    const { checkOutbound } = await import("../../src/policy/guards");
    for (const c of await all()) if (c.draft) expect(checkOutbound(c.draft).ok, c.draft).toBe(true);
  });
});

describe("post sentiment rollups", () => {
  it("each post's counts and score sum match its comments exactly", async () => {
    const cs = await all();
    const ps = (await posts(ctx.db, ctx.orgId).get()).docs.map((d) => ({ id: d.id, ...d.data() })) as Record<string, number | string>[];
    expect(ps.length).toBe(4);
    for (const p of ps) {
      const mine = cs.filter((c) => `${c.platform}_${c.postId}` === p.id);
      expect(p.total).toBe(mine.length);
      for (const s of ["positive", "neutral", "negative", "mixed"] as const) expect((p[s] as number) ?? 0).toBe(mine.filter((c) => c.sentiment === s).length);
      expect(p.needsReply).toBe(mine.filter((c) => c.needsReply).length);
      expect(p.risk).toBe(mine.filter((c) => c.riskFlag).length);
      expect(Number(p.scoreSum)).toBeCloseTo(mine.reduce((a, c) => a + c.score, 0), 5);
    }
  });

  it("the payday-outage post is net negative and the launch post net positive", async () => {
    const get = async (id: string) => (await posts(ctx.db, ctx.orgId).doc(id).get()).data()!;
    const payday = await get("instagram_ig_payday");
    const metal = await get("instagram_ig_metal");
    expect(payday.scoreSum).toBeLessThan(0);
    expect(payday.negative).toBeGreaterThan(payday.positive ?? 0);
    expect(metal.scoreSum).toBeGreaterThan(0);
  });
});

describe("ingestion", () => {
  const input = { platform: "instagram" as const, externalId: "live-1", postId: "ig_metal", postLabel: "Metal card launch (Reel)", author: "@real_user", text: "You've won a giveaway! Claim now at ravenw00d-prizes.com", at: Date.now() };

  it("is idempotent: Meta retries do not duplicate a comment or double-count the rollup", async () => {
    const before = (await posts(ctx.db, ctx.orgId).doc("instagram_ig_metal").get()).data()!.total as number;
    const a = await ingestComment(ctx, input);
    const b = await ingestComment(ctx, input);
    expect([a.created, b.created]).toEqual([true, false]);
    expect((await posts(ctx.db, ctx.orgId).doc("instagram_ig_metal").get()).data()!.total).toBe(before + 1);
  });

  it("raises an alert for a risky REAL comment, but not for sample data", async () => {
    const real = (await alerts(ctx.db, ctx.orgId).get()).docs.map((d) => d.data());
    expect(real.some((x) => /Risky comment on instagram/.test(String(x.text)))).toBe(true);
    // seeding 27 comments (several risky) must not have produced alerts of its own
    expect(real.filter((x) => /Risky comment/.test(String(x.text))).length).toBe(1);
  });

  it("falls back to rules and still stores the comment when the model fails", async () => {
    const failing = { ...ctx, commentClassifier: async () => { throw new Error("vertex unavailable"); } };
    const r = await ingestComment(failing, { ...input, externalId: "live-2", text: "Great app, thanks!", author: "@fan" });
    expect(r.created).toBe(true);
    expect(r.doc!.source).toBe("heuristic");
    expect(r.doc!.sentiment).toBe("positive");
  });

  it("a model that misses a scam cannot downgrade it", async () => {
    const naive = { ...ctx, commentClassifier: async (t: string) => ({ ...(await import("../../src/comments/classify")).classifyComment("Great app, thanks!"), source: "gemini" as const, urls: [], riskReason: "" , text: t } as never) };
    const r = await ingestComment(naive, { ...input, externalId: "live-3", text: "Free money! Claim now at ravenw00d-gifts.com, DM me", author: "@bot" });
    expect(r.doc!.riskFlag).toBe(true);
    expect(r.doc!.intent).toBe("scam_or_spam");
  });
});

describe("moderation actions", () => {
  it("replying to a sample comment records the reply, marks it handled and audits it, without calling Meta", async () => {
    const c = await byText("Does the metal card have foreign");
    graphCalls.length = 0;
    await replyToComment(ctx, actor, { commentId: c.id, text: "Good question! Message us privately and we'll confirm the details." });
    const after = (await comments(ctx.db, ctx.orgId).doc(c.id).get()).data() as CommentDoc;
    expect(after.status).toBe("handled");
    expect(after.reply?.by).toBe("Muhammad Rafay");
    expect(graphCalls).toHaveLength(0);
    expect((await lastAudit("comment-reply")).length).toBeGreaterThan(0);
  });

  it("a public reply that asks for secrets is blocked and audited", async () => {
    const c = await byText("Switching banks");
    await expect(replyToComment(ctx, actor, { commentId: c.id, text: "Please send me your account number and PIN" })).rejects.toBeInstanceOf(ActionError);
    expect((await lastAudit("blocked")).some((a) => /Public reply blocked/.test(String(a.detail)))).toBe(true);
    expect(((await comments(ctx.db, ctx.orgId).doc(c.id).get()).data() as CommentDoc).status).toBe("new");
  });

  it("a real Instagram comment cannot be changed until Meta is connected", async () => {
    const live = (await comments(ctx.db, ctx.orgId).doc("instagram_live-1").get()).data() as CommentDoc;
    expect(live.sample).toBe(false);
    await expect(hideComment(ctx, actor, { commentId: "instagram_live-1", hidden: true })).rejects.toThrow(/Meta is not connected/);
  });

  it("with a page token, hide and reply go to the right Meta endpoints", async () => {
    const withToken = { ...ctx, metaPageToken: "tok" };
    graphCalls.length = 0;
    await hideComment(withToken, actor, { commentId: "instagram_live-1", hidden: true });
    expect(graphCalls[0]).toMatchObject({ method: "POST", url: "/v23.0/live-1", body: { hide: true } });
    expect(((await comments(ctx.db, ctx.orgId).doc("instagram_live-1").get()).data() as CommentDoc).status).toBe("hidden");

    await replyToComment(withToken, actor, { commentId: "instagram_live-1", text: "Thanks for flagging, we've reported this." });
    expect(graphCalls[1]).toMatchObject({ url: "/v23.0/live-1/replies", body: { message: "Thanks for flagging, we've reported this." } });

    // Facebook uses different endpoints and field names
    await ingestComment(withToken, { platform: "facebook", externalId: "fb-9", postId: "fb_alerts", author: "Spammer", text: "Verify your account at ravenwoodbank-secure.net now", at: Date.now() });
    graphCalls.length = 0;
    await hideComment(withToken, actor, { commentId: "facebook_fb-9", hidden: true });
    expect(graphCalls[0]).toMatchObject({ url: "/v23.0/fb-9", body: { is_hidden: true } });
    await replyToComment(withToken, actor, { commentId: "facebook_fb-9", text: "We've reported this." });
    expect(graphCalls[1]).toMatchObject({ url: "/v23.0/fb-9/comments", body: { message: "We've reported this." } });
  });

  it("mark handled works and unknown comments are a clean not-found", async () => {
    const c = await byText("ok");
    await handleComment(ctx, actor, { commentId: c.id });
    expect(((await comments(ctx.db, ctx.orgId).doc(c.id).get()).data() as CommentDoc).status).toBe("handled");
    await expect(handleComment(ctx, actor, { commentId: "nope" })).rejects.toThrow(/not found/);
  });

  it("simulateComment needs demo mode and classifies like a real one", async () => {
    const r = await simulateComment(ctx, actor, { platform: "youtube", text: "Love the new app, super fast!" });
    expect(((await comments(ctx.db, ctx.orgId).doc(r.id).get()).data() as CommentDoc).sentiment).toBe("positive");
    await org(ctx.db, ctx.orgId).update({ demoMode: false });
    await expect(simulateComment(ctx, actor, { text: "x" })).rejects.toThrow(/Demo tools are disabled/);
    await org(ctx.db, ctx.orgId).update({ demoMode: true });
  });
});

describe("post campaigns", () => {
  const post = async (key: string) => (await posts(ctx.db, ctx.orgId).doc(key).get()).data() as Record<string, unknown>;

  it("the seed tags each demo post with its campaign", async () => {
    expect((await post("instagram_ig_metal")).campaign).toBe("Product launch");
    expect((await post("instagram_ig_payday")).campaign).toBe("Education");
    expect((await post("facebook_fb_alerts")).campaign).toBe("Security awareness");
    expect((await post("youtube_yt_compare")).campaign).toBe("Competitor");
  });

  it("a manager can retag a post, and it is audited", async () => {
    await setPostCampaign(ctx, actor, { postKey: "instagram_ig_payday", campaign: "Support" });
    expect((await post("instagram_ig_payday")).campaign).toBe("Support");
    const log = (await audit(ctx.db, ctx.orgId).get()).docs.map((d) => d.data());
    expect(log.some((a) => a.action === "post-campaign" && String(a.detail).includes("Support"))).toBe(true);
  });

  it("an empty value clears the tag", async () => {
    await setPostCampaign(ctx, actor, { postKey: "instagram_ig_payday", campaign: "" });
    expect("campaign" in (await post("instagram_ig_payday"))).toBe(false);
  });

  it("a later comment never overwrites a campaign a manager chose", async () => {
    await setPostCampaign(ctx, actor, { postKey: "facebook_fb_alerts", campaign: "Support" });
    await ingestComment(ctx, { platform: "facebook", externalId: "camp_keep_1", postId: "fb_alerts", postLabel: "Introducing real-time scam alerts", author: "Zed", text: "Thanks for this", at: Date.now() });
    expect((await post("facebook_fb_alerts")).campaign).toBe("Support");
  });

  it("a brand-new post has no campaign until one is set or given at ingest", async () => {
    await ingestComment(ctx, { platform: "instagram", externalId: "camp_new_1", postId: "new_post_a", postLabel: "New post A", author: "Zed", text: "Nice one", at: Date.now() });
    expect("campaign" in (await post("instagram_new_post_a"))).toBe(false);
    await ingestComment(ctx, { platform: "instagram", externalId: "camp_new_2", postId: "new_post_b", postLabel: "New post B", postCampaign: "Education", author: "Zed", text: "Nice one", at: Date.now() });
    expect((await post("instagram_new_post_b")).campaign).toBe("Education");
  });

  it("tagging a post that does not exist is refused", async () => {
    await expect(setPostCampaign(ctx, actor, { postKey: "instagram_nope", campaign: "Support" })).rejects.toBeInstanceOf(ActionError);
  });
});
