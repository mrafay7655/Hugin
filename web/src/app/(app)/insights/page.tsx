"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { ChevronRight, MessageSquareText, ShieldAlert } from "lucide-react";
import { call, useCollection } from "@/lib/data";
import { useAction } from "@/lib/toast";
import { useQuery } from "@/lib/url-state";
import { CAMPAIGNS, UNTAGGED } from "@/lib/campaigns";
import type { Comment, CommentSentiment, Post, WithId } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Empty, Loading, PLATFORMS, SentimentBadge, ago, human, useTick } from "@/components/ui";

const SENTS: CommentSentiment[] = ["positive", "neutral", "mixed", "negative"];
const COLOR: Record<CommentSentiment, string> = { positive: "var(--ok, #17763F)", neutral: "var(--n300, #D4D4D8)", mixed: "var(--warn, #B7791F)", negative: "var(--err, #D93F3F)" };
const RANGES: [string, string, number][] = [["all", "Any time", 0], ["24h", "Last 24 hours", 864e5], ["7d", "Last 7 days", 7 * 864e5], ["30d", "Last 30 days", 30 * 864e5]];

const postKey = (c: Comment) => `${c.platform}_${c.postId}`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const olderThan = (at: number, ms: number) => Date.now() - at > ms;
const netColor = (n: number) => (n >= 0.15 ? "var(--ok, #17763F)" : n <= -0.15 ? "var(--err, #D93F3F)" : "var(--text-2)");

interface Roll { total: number; net: number; split: number[]; risky: number; topics: [string, number][] }
function roll(cs: Comment[]): Roll {
  const topics = new Map<string, number>();
  for (const c of cs) if (c.topic && c.topic !== "other") topics.set(c.topic, (topics.get(c.topic) ?? 0) + 1);
  return {
    total: cs.length,
    net: cs.length ? cs.reduce((a, c) => a + c.score, 0) / cs.length : 0,
    split: SENTS.map((s) => cs.filter((c) => c.sentiment === s).length),
    risky: cs.filter((c) => c.riskFlag && c.status !== "hidden").length,
    topics: [...topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

function SplitBar({ r, height = 6 }: { r: Roll; height?: number }) {
  return (
    <div style={{ display: "flex", height, borderRadius: height / 2, overflow: "hidden", background: "var(--n100, #F4F4F5)" }} aria-label="Sentiment split">
      {SENTS.map((s, i) => r.split[i] > 0 && <i key={s} style={{ width: `${(r.split[i] / r.total) * 100}%`, background: COLOR[s] }} title={`${s}: ${r.split[i]}`} />)}
    </div>
  );
}

const Topics = ({ r }: { r: Roll }) => (
  <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
    {r.topics.length ? r.topics.map(([t, n]) => <span key={t} className="chip">{human(t)} · {n}</span>) : <span className="faint" style={{ fontSize: 12 }}>No clear topic yet</span>}
  </div>
);

export default function InsightsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InsightsScreen />
    </Suspense>
  );
}

/** How people feel, one level at a time: campaigns, then the posts in a campaign, then one post's comments. */
function InsightsScreen() {
  useTick(60000);
  const q = useQuery();
  const act = useAction();
  const { data: comments, loading } = useCollection<Comment>("comments", { order: ["at", "desc"] });
  const { data: posts } = useCollection<Post>("posts");

  const campaign = q.get("c");
  const post = q.get("post");
  const platform = q.get("p");
  const range = q.get("r");
  const sent = q.get("s");
  const rangeMs = RANGES.find((r) => r[0] === range)?.[2] ?? 0;

  const postsByKey = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);
  const campaignOfPost = (key: string) => postsByKey.get(key)?.campaign || UNTAGGED;
  const base = comments.filter((c) => (platform === "all" || c.platform === platform) && (!rangeMs || !olderThan(c.at, rangeMs)));

  const level = post !== "all" ? 3 : campaign !== "all" ? 2 : 1;
  const activePost = post !== "all" ? postsByKey.get(post) : undefined;
  const campaignName = post !== "all" ? campaignOfPost(post) : campaign;
  const retag = (key: string, value: string) => act(() => call("setPostCampaign", { postKey: key, campaign: value }), "Campaign updated");

  if (loading) return <Loading />;

  const campaignRolls = [...CAMPAIGNS, UNTAGGED]
    .map((name) => ({ name, cs: base.filter((c) => campaignOfPost(postKey(c)) === name) }))
    .filter((x) => x.cs.length || posts.some((p) => (p.campaign || UNTAGGED) === x.name && (platform === "all" || p.platform === platform)));
  const inCampaign = base.filter((c) => campaignOfPost(postKey(c)) === campaignName);
  const postRows = posts
    .filter((p) => (p.campaign || UNTAGGED) === campaignName && (platform === "all" || p.platform === platform))
    .map((p) => ({ p, r: roll(base.filter((c) => postKey(c) === p.id)) }))
    .sort((a, b) => b.r.risky - a.r.risky || b.r.total - a.r.total);
  const postComments = base.filter((c) => postKey(c) === post);
  const shownComments = postComments.filter((c) => sent === "all" || c.sentiment === sent);
  const headRoll = level === 3 ? roll(postComments) : roll(inCampaign);

  return (
    <>
      <Topbar title="Social insights" />
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <nav className="row" style={{ gap: 4, fontSize: 14, flexWrap: "wrap" }} aria-label="Breadcrumb">
            <button className="btn ghost sm" style={{ fontWeight: level === 1 ? 600 : 400 }} onClick={() => q.set({ c: null, post: null, s: null })}>All campaigns</button>
            {level >= 2 && <><ChevronRight size={14} className="faint" /><button className="btn ghost sm" style={{ fontWeight: level === 2 ? 600 : 400 }} onClick={() => q.set({ c: campaignName, post: null, s: null })}>{campaignName}</button></>}
            {level === 3 && <><ChevronRight size={14} className="faint" /><span style={{ fontWeight: 600, padding: "0 8px" }}>{activePost?.label ?? post}</span></>}
          </nav>
          <div className="row" style={{ gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
            <select className="input" style={{ width: 150 }} value={platform} onChange={(e) => q.set({ p: e.target.value })} aria-label="Platform">
              <option value="all">All platforms</option>
              {Object.entries(PLATFORMS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input" style={{ width: 150 }} value={range} onChange={(e) => q.set({ r: e.target.value })} aria-label="Time range">
              {RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </div>

        {level === 1 && (
          <>
            <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>How people feel about each campaign. Open one to see its posts, then a post to read the comments.</p>
            {campaignRolls.length === 0 && <Empty icon={MessageSquareText} title="No comments yet">Comments will appear here as they are classified.</Empty>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 12 }}>
              {campaignRolls.map(({ name, cs }) => {
                const r = roll(cs);
                return (
                  <button key={name} className="card" onClick={() => q.set({ c: name })} style={{ textAlign: "left", padding: 16, cursor: "pointer", border: 0 }}>
                    <div className="row" style={{ gap: 8, marginBottom: 10 }}>
                      <b style={{ fontSize: 14.5 }}>{name}</b>
                      <span className="mono" style={{ marginLeft: "auto", fontSize: 15, fontWeight: 600, color: netColor(r.net) }}>{r.total ? signed(r.net) : "–"}</span>
                    </div>
                    {r.total ? <SplitBar r={r} height={8} /> : <div className="faint" style={{ fontSize: 12.5 }}>No comments in this range</div>}
                    <div className="row faint" style={{ fontSize: 12, gap: 10, margin: "10px 0" }}>
                      <span>{r.total} comments</span>
                      <span>{Math.round((r.split[0] / (r.total || 1)) * 100)}% positive</span>
                      <span>{Math.round((r.split[3] / (r.total || 1)) * 100)}% negative</span>
                      {r.risky > 0 && <span style={{ color: "var(--err, #D93F3F)" }}><ShieldAlert size={11} style={{ verticalAlign: -1 }} /> {r.risky} risky</span>}
                    </div>
                    <Topics r={r} />
                  </button>
                );
              })}
            </div>
          </>
        )}

        {level >= 2 && (
          <div className="card" style={{ padding: 16, display: "grid", gap: 10 }}>
            <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
              <b style={{ fontSize: 15 }}>{level === 3 ? (activePost?.label ?? post) : campaignName}</b>
              {level === 3 && activePost && <span className="faint" style={{ fontSize: 12.5 }}><span className="dot" style={{ background: PLATFORMS[activePost.platform]?.color }} /> {PLATFORMS[activePost.platform]?.label}</span>}
              <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: netColor(headRoll.net) }}>{headRoll.total ? signed(headRoll.net) : "–"}</span>
              <span className="faint" style={{ fontSize: 12.5 }}>{headRoll.total} comments · {headRoll.risky} risky</span>
              {level === 3 && activePost && (
                <label className="row faint" style={{ gap: 6, fontSize: 12, marginLeft: "auto" }}>Campaign
                  <select className="input" style={{ width: 160 }} value={activePost.campaign ?? ""} onChange={(e) => retag(activePost.id, e.target.value)}>
                    <option value="">{UNTAGGED}</option>
                    {CAMPAIGNS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
            </div>
            {headRoll.total > 0 && <SplitBar r={headRoll} height={8} />}
            <Topics r={headRoll} />
          </div>
        )}

        {level === 2 && (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {postRows.length === 0 && <Empty icon={MessageSquareText} title="No posts here">No posts in this campaign for the selected platform.</Empty>}
            {postRows.map(({ p, r }) => (
              <div key={p.id} className="row" style={{ gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--n100)", flexWrap: "wrap" }}>
                <button onClick={() => q.set({ post: p.id, c: campaignName })} style={{ flex: "1 1 240px", textAlign: "left", border: 0, background: "none", cursor: "pointer", font: "inherit", color: "inherit", padding: 0 }}>
                  <div className="row" style={{ gap: 6 }}><span className="dot" style={{ background: PLATFORMS[p.platform]?.color }} /><b style={{ fontWeight: 500, fontSize: 13.5 }}>{p.label}</b></div>
                  <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>{PLATFORMS[p.platform]?.label} · {r.total} comments{r.risky ? <span style={{ color: "var(--err, #D93F3F)" }}> · {r.risky} risky</span> : null}</div>
                </button>
                <div style={{ width: 150 }}>{r.total ? <SplitBar r={r} /> : <span className="faint" style={{ fontSize: 12 }}>none in range</span>}</div>
                <span className="mono" style={{ width: 56, textAlign: "right", fontWeight: 600, color: netColor(r.net) }}>{r.total ? signed(r.net) : "–"}</span>
                <select className="input" style={{ width: 150 }} value={p.campaign ?? ""} onChange={(e) => retag(p.id, e.target.value)} aria-label={`Campaign for ${p.label}`}>
                  <option value="">{UNTAGGED}</option>
                  {CAMPAIGNS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button className="btn ghost sm" onClick={() => q.set({ post: p.id, c: campaignName })}>Open</button>
              </div>
            ))}
          </div>
        )}

        {level === 3 && (
          <>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="faint" style={{ fontSize: 12.5 }}>Show</span>
              <button className="chip" style={{ cursor: "pointer", border: 0, background: sent === "all" ? "var(--accent)" : undefined, color: sent === "all" ? "#fff" : undefined }} onClick={() => q.set({ s: null })}>All {headRoll.total}</button>
              {SENTS.map((s, i) => (
                <button key={s} className="chip" disabled={!headRoll.split[i] && sent !== s} style={{ cursor: "pointer", border: 0, opacity: headRoll.split[i] || sent === s ? 1 : 0.45, background: sent === s ? "var(--accent)" : undefined, color: sent === s ? "#fff" : undefined }} onClick={() => q.set({ s: sent === s ? null : s })}>
                  <span className="dot" style={{ background: COLOR[s] }} />{s[0].toUpperCase() + s.slice(1)} {headRoll.split[i]}
                </button>
              ))}
            </div>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {shownComments.length === 0 && <Empty icon={MessageSquareText} title="No comments">Nothing matches for this post.</Empty>}
              {shownComments.map((c: WithId<Comment>) => (
                <div key={c.id} style={{ padding: "12px 16px", borderBottom: "1px solid var(--n100)" }}>
                  <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                    <b style={{ fontWeight: 500, fontSize: 13 }}>{c.author}</b>
                    <span className="mono faint" style={{ fontSize: 11 }}>{ago(c.at)}</span>
                    <SentimentBadge s={c.sentiment} sarcasm={c.sarcasm} />
                    {c.riskFlag && <span className="badge b-err"><ShieldAlert />{human(c.intent)}</span>}
                    <Link href={`/comments?view=all&q=${encodeURIComponent(c.author)}`} className="faint" style={{ marginLeft: "auto", fontSize: 12, textDecoration: "underline" }}>Open in Moderation</Link>
                  </div>
                  <div style={{ fontSize: 13.5, color: "var(--text-2)" }}>{c.text}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
