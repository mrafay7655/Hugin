"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { ChartNoAxesColumn, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, EyeOff, Eye as EyeOn, MessageSquareText, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import { useSession } from "@/lib/auth";
import { call, useCollection } from "@/lib/data";
import { useAction } from "@/lib/toast";
import { useQuery } from "@/lib/url-state";
import { UNTAGGED } from "@/lib/campaigns";
import type { Comment, Post, WithId } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Empty, Loading, OriginBadge, PLATFORMS, SentimentBadge, ago, human, originOf, useTick } from "@/components/ui";
import { useIsJudge } from "@/lib/auth";

type View = "attention" | "all" | "handled" | "hidden";
const PAGE = 10;

const needsAttention = (c: Comment) => c.status === "new" && (c.needsReply || c.riskFlag || c.suggestHide);
const isRisky = (c: Comment) => c.riskFlag && c.status !== "hidden";
const postKey = (c: Comment) => `${c.platform}_${c.postId}`;
const inView = (c: Comment, v: View) => (v === "attention" ? needsAttention(c) : v === "all" ? true : c.status === v);

export default function ModerationPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ModerationScreen />
    </Suspense>
  );
}

/** The action queue only: what needs a reply, what is a scam, what to hide. Sentiment analysis lives in Social insights. */
function ModerationScreen() {
  useTick(30000);
  const q = useQuery();
  const { data: comments, loading } = useCollection<Comment>("comments", { order: ["at", "desc"] });
  const { data: posts } = useCollection<Post>("posts");
  const [sel, setSel] = useState<string | null>(null);
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState<Record<string, number>>({});
  const [hideSample, setHideSample] = useState(useIsJudge());

  // "all" is how the URL helper says "remove this filter", so the All tab is stored as "everything".
  const rawView = q.get("view", "attention");
  const view = (rawView === "everything" ? "all" : rawView) as View;
  const platform = q.get("p");
  const search = q.get("q", "");

  const postsByKey = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);
  const matches = (c: Comment, skipPlatform = false) =>
    (!hideSample || originOf(c) !== "sample") && (skipPlatform || platform === "all" || c.platform === platform) && (!search || `${c.author} ${c.text} ${c.postLabel}`.toLowerCase().includes(search.toLowerCase()));

  const scoped = comments.filter((c) => matches(c));
  const list = scoped.filter((c) => inView(c, view)).sort((a, b) => Number(b.riskFlag) - Number(a.riskFlag) || b.at - a.at);
  const groups: { key: string; title: string; items: WithId<Comment>[] }[] =
    view === "attention" || view === "all"
      ? [
          { key: "risky", title: "Risky: review first", items: list.filter(isRisky) },
          { key: "reply", title: "Needs a reply", items: list.filter((c) => !isRisky(c) && c.needsReply && c.status === "new") },
          { key: "rest", title: view === "attention" ? "Other items needing attention" : "Everything else", items: list.filter((c) => !isRisky(c) && !(c.needsReply && c.status === "new")) },
        ].filter((g) => g.items.length)
      : [{ key: view, title: view === "handled" ? "Handled" : "Hidden", items: list }];
  const visible = groups.flatMap((g) => (shut[g.key] ? [] : g.items.slice(0, PAGE + (more[g.key] ?? 0))));
  const current = list.find((c) => c.id === sel) ?? visible[0];

  const tabCount = (v: View) => scoped.filter((c) => inView(c, v)).length;
  const platformCount = (k: string) => comments.filter((c) => matches(c, true) && inView(c, view) && c.platform === k).length;

  if (loading) return <Loading />;
  return (
    <>
      <Topbar title="Moderation">
        <input className="input" style={{ width: 220, height: 30 }} placeholder="Search comments or authors" value={search} onChange={(e) => q.set({ q: e.target.value })} aria-label="Search" />
      </Topbar>
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          <div className="tabs" style={{ margin: 0 }}>
            {([["attention", "Needs attention"], ["all", "All"], ["handled", "Handled"], ["hidden", "Hidden"]] as [View, string][]).map(([k, l]) => (
              <button key={k} className={"tab" + (view === k ? " on" : "")} onClick={() => q.set({ view: k === "attention" ? null : k === "all" ? "everything" : k })}>{l}<span className="cnt">{tabCount(k)}</span></button>
            ))}
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button className="chip" style={{ cursor: "pointer", border: 0, background: platform === "all" ? "var(--accent)" : undefined, color: platform === "all" ? "#fff" : undefined }} onClick={() => q.set({ p: null })}>All</button>
            {Object.entries(PLATFORMS).map(([k, v]) => {
              const n = platformCount(k);
              const on = platform === k;
              if (!n && !on) return null;
              return (
                <button key={k} className="chip" style={{ cursor: "pointer", border: 0, background: on ? "var(--accent)" : undefined, color: on ? "#fff" : undefined }} onClick={() => q.set({ p: on ? null : k })}>
                  <span className="dot" style={{ background: v.color }} />{v.label} <span className="mono" style={{ fontSize: 11 }}>{n}</span>
                </button>
              );
            })}
          </div>
          <label className="row" style={{ gap: 6, fontSize: 12.5, cursor: "pointer" }}>
            <input type="checkbox" checked={hideSample} onChange={(e) => setHideSample(e.target.checked)} />
            Hide sample data
          </label>
          <Link href="/insights" className="btn ghost sm" style={{ marginLeft: "auto" }}><ChartNoAxesColumn size={14} />How do people feel? Social insights</Link>
        </div>

        <div className="cm-grid cm-two">
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            {list.length === 0 && <Empty icon={MessageSquareText} title="Nothing here">{search || platform !== "all" ? "No comments match." : "You're all caught up."}</Empty>}
            {groups.map((g) => {
              const shown = g.items.slice(0, PAGE + (more[g.key] ?? 0));
              return (
                <div key={g.key}>
                  <button onClick={() => setShut((s) => ({ ...s, [g.key]: !s[g.key] }))} style={{ display: "flex", width: "100%", alignItems: "center", gap: 6, border: 0, borderBottom: "1px solid var(--n100)", background: "var(--sunken)", padding: "8px 14px", cursor: "pointer", font: "inherit", color: g.key === "risky" ? "var(--err, #D93F3F)" : "inherit", fontWeight: 600, fontSize: 12.5 }}>
                    {shut[g.key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{g.title}
                    <span className="mono" style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11.5 }}>{g.items.length}</span>
                  </button>
                  {!shut[g.key] && shown.map((c) => (
                    <button key={c.id} onClick={() => setSel(c.id)} className={"li" + (c.id === current?.id ? " on" : "")} style={{ width: "100%", textAlign: "left", display: "block" }}>
                      <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                        <span className="dot" style={{ background: PLATFORMS[c.platform]?.color }} />
                        <b style={{ fontWeight: 500, fontSize: 13 }}>{c.author}</b>
                        <span className="faint ellipsis" style={{ fontSize: 12 }}>on {c.postLabel}</span>
                        <span className="mono faint" style={{ marginLeft: "auto", fontSize: 11 }}>{ago(c.at)}</span>
                      </div>
                      <div className="ellipsis" style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 6 }}>{c.text}</div>
                      <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
                        {c.riskFlag && <span className="badge b-err"><ShieldAlert />{human(c.intent)}</span>}
                        {!c.riskFlag && c.needsReply && c.status === "new" && <span className="badge b-acc">Needs reply</span>}
                        {c.status !== "new" && <span className="badge b-n">{c.status === "handled" ? "Handled" : "Hidden"}</span>}
                        <SentimentBadge s={c.sentiment} sarcasm={c.sarcasm} />
                        <OriginBadge o={originOf(c)} />
                      </div>
                    </button>
                  ))}
                  {!shut[g.key] && g.items.length > shown.length && (
                    <button className="btn ghost sm" style={{ margin: "8px 14px" }} onClick={() => setMore((m) => ({ ...m, [g.key]: (m[g.key] ?? 0) + PAGE }))}>Show {Math.min(PAGE, g.items.length - shown.length)} more of {g.items.length - shown.length}</button>
                  )}
                </div>
              );
            })}
          </div>
          {/* On a phone the detail slides up as its own screen once a comment is chosen; from 1000px it sits beside the list. */}
          <div className={"sheet" + (sel ? " open" : "")}>
            <div className="sheet-bar">
              <button className="btn ghost icon" onClick={() => setSel(null)} aria-label="Back to the list"><ChevronLeft size={20} /></button>
              Comment
            </div>
            <div className="sheet-in">{current ? <Detail key={current.id} c={current} campaign={postsByKey.get(postKey(current))?.campaign || UNTAGGED} /> : <div />}</div>
          </div>
        </div>
      </div>
    </>
  );
}

function Detail({ c, campaign }: { c: WithId<Comment>; campaign: string }) {
  const s = useSession();
  const act = useAction();
  const judgeLocked = s.role === "judge" && !c.sample; // a judge may only act on sample comments
  const [text, setText] = useState(c.draft ?? "");
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    await act(fn, ok);
    setBusy(false);
  };
  const insightsHref = `/insights?c=${encodeURIComponent(campaign)}&post=${encodeURIComponent(postKey(c))}`;
  return (
    <div className="card tg-sticky" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className="dot" style={{ background: PLATFORMS[c.platform]?.color }} />
          <b style={{ fontWeight: 500 }}>{c.author}</b>
          <span className="faint" style={{ fontSize: 12 }}>· {PLATFORMS[c.platform]?.label} · {ago(c.at)}</span>
          <Link href={insightsHref} className="faint" style={{ fontSize: 12, marginLeft: "auto", textDecoration: "underline" }}>{c.postLabel} in Social insights</Link>
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.55, margin: "10px 0 0" }}>{c.text}</p>
      </div>

      {c.riskFlag && (
        <div className="banner" style={{ background: "var(--err-bg)", color: "#8F2424", fontSize: 13, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 2 }} />
          <span><b style={{ fontWeight: 500 }}>Risk: {human(c.intent)}.</b> {c.riskReason}{c.suggestHide ? " Hiding is recommended so other customers don't click it." : ""}</span>
        </div>
      )}

      <div className="sunk">
        <div className="row" style={{ gap: 6, flexWrap: "wrap", fontSize: 12.5 }}>
          <Sparkles size={13} style={{ color: "var(--a700)" }} />
          <span style={{ color: "var(--a700)", fontWeight: 500 }}>{c.source === "gemini" ? "Gemini" : "Rules"} read this as</span>
          <SentimentBadge s={c.sentiment} sarcasm={c.sarcasm} />
          <span className="chip">{human(c.intent)}</span>
          <span className="chip">{human(c.topic)}</span>
          <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => setMore((m) => !m)}>{more ? "Hide details" : "Details"}</button>
        </div>
        {more && (
          <div style={{ marginTop: 8 }}>
            <div className="kv"><span>Score</span><span className="mono">{c.score >= 0 ? "+" : ""}{c.score.toFixed(2)}</span></div>
            <div className="kv"><span>Emotion</span><span>{c.emotion}</span></div>
            <div className="kv"><span>Toxicity</span><span className="mono">{c.toxicity.toFixed(2)}</span></div>
            <div className="kv"><span>Needs a reply</span><span>{c.needsReply ? "Yes" : "No"}</span></div>
          </div>
        )}
      </div>

      {c.reply ? (
        <div className="sunk">
          <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>Replied by {c.reply.by} · {ago(c.reply.at)}</div>
          <div style={{ fontSize: 13.5 }}>{c.reply.text}</div>
        </div>
      ) : c.intent === "scam_or_spam" ? (
        <div className="faint" style={{ fontSize: 12.5 }}>No reply is drafted for scams or spam, so nobody engages with it by accident.</div>
      ) : (
        <div>
          <label className="label" htmlFor="reply">Public reply {c.draft && <span className="faint">· drafted by HUGIN, you decide</span>}</label>
          <textarea id="reply" className="input" rows={3} value={text} disabled={judgeLocked} onChange={(e) => setText(e.target.value)} placeholder="Write a public reply…" />
          {c.draftCite && <div style={{ marginTop: 6 }}><span className="cite">Source · {c.draftCite.doc} {c.draftCite.section}</span></div>}
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Public replies that ask for codes, PINs, card or account numbers are blocked.</div>
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        {judgeLocked && <div className="faint" style={{ fontSize: 12, flexBasis: "100%" }}>Judges can only act on sample comments, never on a real public comment.</div>}
        {c.status !== "handled" && <button className="btn ghost sm" disabled={busy || judgeLocked} onClick={() => run(() => call("handleComment", { commentId: c.id }), "Marked handled")}><CheckCheck size={14} />Mark handled</button>}
        <button className={"btn sm " + (c.suggestHide && c.status !== "hidden" ? "danger" : "secondary")} disabled={busy || judgeLocked} onClick={() => run(() => call("hideComment", { commentId: c.id, hidden: c.status !== "hidden" }), c.status === "hidden" ? "Comment shown again" : "Comment hidden")}>
          {c.status === "hidden" ? <><EyeOn size={14} />Unhide</> : <><EyeOff size={14} />Hide</>}
        </button>
        {!c.reply && c.intent !== "scam_or_spam" && (
          <button className="btn primary sm" disabled={busy || judgeLocked || text.trim().length < 2} onClick={() => run(() => call("replyToComment", { commentId: c.id, text: text.trim() }), c.sample ? "Reply recorded (sample comment, not posted)" : "Reply posted")}>Reply publicly</button>
        )}
      </div>
    </div>
  );
}
