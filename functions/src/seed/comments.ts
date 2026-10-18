import { ingestComment, type Campaign, type CommentInput, type CommentPlatform } from "../comments/ingest";
import { comments, posts } from "../lib/paths";
import type { Ctx } from "../agent/context";

const MIN = 60_000;

interface SeedPost { id: string; platform: CommentPlatform; label: string; campaign: Campaign; comments: [author: string, text: string, minutesAgo: number][] }

/**
 * Realistic public comments on the bank's own posts, for the Comments screen.
 * They flow through the real classifier; nothing here is pre-labelled.
 */
const POSTS: SeedPost[] = [
  { id: "ig_metal", platform: "instagram", label: "Metal card launch (Reel)", campaign: "Product launch", comments: [
    ["@sana.styles", "Loving the new metal card from @ravenwood ✨", 180],
    ["@mike_travels", "Does the metal card have foreign transaction fees? Heading to Japan next month", 150],
    ["@jaylen.k", "Great design but the annual fee is terrible", 140],
    ["@priya.invests", "Impressive perks. Thank you for finally launching this!", 120],
    ["@promo_hunter88", "You've won a $500 giveaway! Claim now at ravenw00d-rewards.com", 95],
    ["@nate.b", "How long does shipping take for the metal card?", 70],
    ["@finance_fran", "Best card I've had. Fast approval, friendly support.", 40],
  ] },
  { id: "ig_payday", platform: "instagram", label: "Payday tips (Carousel)", campaign: "Education", comments: [
    ["@zoecodes", "Love waiting to see my paycheck. Thanks Ravenwood 🙃", 55],
    ["@leah.m", "App is down again on payday, can't pay rent. Fix this", 50],
    ["@dev_tom", "Third time this month the app crashes at login. Seriously?", 46],
    ["@sofia.r", "Is the app down for everyone or just me?", 44],
    ["@cass_nyc", "Ravenwood login broken for 2 hours now. Any update??", 38],
    ["@ray_l", "Switching banks if this happens one more time", 30],
    ["@kim.codes", "Thanks for the quick fix! Working again for me", 8],
  ] },
  { id: "fb_alerts", platform: "facebook", label: "Introducing real-time scam alerts", campaign: "Security awareness", comments: [
    ["Linda Alvarez", "This is exactly what my dad needed. Thank you, truly helpful.", 300],
    ["Robert Miller", "Got a text 'from Ravenwood' saying my account is locked with a link to ravenw00d-verify.com. Fake right?", 260],
    ["Tom Becker", "How do I turn on the alerts in the app?", 210],
    ["Greg H.", "Someone called pretending to be you and asked for my OTP. Glad I didn't give it", 175],
    ["CryptoKing Official", "DM me for a guaranteed crypto investment opportunity, limited offer", 160],
    ["Angela W.", "Why are you charging $30 overdraft fees AND making me pay for alerts? Ridiculous.", 90],
    ["Sam P.", "I will report this to the CFPB and get a lawyer if my money isn't back by Friday", 20],
  ] },
  { id: "yt_compare", platform: "youtube", label: "Ravenwood vs Harborline: best checking in 2026?", campaign: "Competitor", comments: [
    ["MoneyWithMike", "Honest comparison. Ravenwood wins on fraud protection, Harborline on fees.", 400],
    ["budgetbae", "Harborline just dropped overdraft fees entirely, hard to beat that", 360],
    ["Dana K", "Ravenwood's customer service actually called me back within 10 minutes. Impressed.", 330],
    ["Chris_92", "What's the fee for an international wire at Ravenwood?", 300],
    ["WalletWatcher", "Switching to Harborline, Ravenwood fees are unfair and the app keeps crashing", 240],
    ["Priya S", "Not bad at all, thanks for the video", 200],
  ] },
];

/**
 * Replaces the SAMPLE posts and comments with the demo set, through the real classification path.
 * Real comments from Instagram or Facebook are never deleted.
 */
export async function seedComments(ctx: Ctx): Promise<{ posts: number; comments: number }> {
  for (const col of [comments(ctx.db, ctx.orgId), posts(ctx.db, ctx.orgId)]) {
    const old = await col.where("sample", "==", true).get();
    await Promise.all(old.docs.map((d) => d.ref.delete()));
  }
  let n = 0;
  const now = ctx.now();
  // Ids are assigned up front so they stay stable; each post then runs in parallel, because every comment is a Gemini call.
  const jobs = POSTS.map((p) => p.comments.map(([author, text, ago]): CommentInput => ({ platform: p.platform, externalId: `seed${++n}`, postId: p.id, postLabel: p.label, postCampaign: p.campaign, author, text, at: now - ago * MIN, sample: true })));
  await Promise.all(jobs.map(async (inputs) => { for (const input of inputs) await ingestComment(ctx, input); }));
  return { posts: POSTS.length, comments: n };
}
