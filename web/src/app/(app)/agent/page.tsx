"use client";

import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { collection, limit as qLimit, onSnapshot, orderBy, query } from "firebase/firestore";
import { Activity, Bot, Brain, Check, CircleAlert, ShieldCheck, Wrench } from "lucide-react";
import { useCollection } from "@/lib/data";
import { useSession } from "@/lib/auth";
import { firebase } from "@/lib/firebase/client";
import type { Comment, Conversation, Customer, Message, Post, Trace, WithId } from "@/lib/types";
import { CAMPAIGNS, UNTAGGED } from "@/lib/campaigns";
import { Topbar } from "@/components/shell";
import { CHANNELS, ChannelBadge, ConfidenceBadge, Empty, Loading, PLATFORMS, SentimentBadge, Stat, clock, human, timeAgo, useTick } from "@/components/ui";

type Run = { convId: string; t: WithId<Trace> };
type LogLine = { tag: string; text: string; tone?: "ok" | "warn" | "err" };

/** The latest few agent runs of the most recently active conversations, live. */
function useRuns(convIds: string[]): Run[] {
  const { orgId } = useSession();
  const [byConv, setByConv] = useState<Record<string, WithId<Trace>[]>>({});
  const key = convIds.join(",");
  useEffect(() => {
    const unsubs = convIds.map((id) =>
      onSnapshot(
        query(collection(firebase().db, "orgs", orgId, "conversations", id, "traces"), orderBy("at", "desc"), qLimit(5)),
        (s) => setByConv((p) => ({ ...p, [id]: s.docs.map((d) => ({ id: d.id, ...(d.data() as Trace) })) })),
        () => {},
      ),
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, orgId]);
  return useMemo(
    () => Object.entries(byConv).filter(([id]) => convIds.includes(id)).flatMap(([convId, ts]) => ts.map((t) => ({ convId, t }))).sort((a, b) => b.t.at - a.t.at),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byConv, key],
  );
}

const pretty = (json: string) => {
  try { return JSON.stringify(JSON.parse(json), null, 1).replace(/\n\s*/g, " "); } catch { return json; }
};

function buildLog(run: Run, who: string, channel: string, msgText: string): LogLine[] {
  const { t } = run;
  const a = t.adk;
  const log: LogLine[] = [{ tag: "inbound", text: `message from ${who} via ${channel}: "${msgText.slice(0, 160)}"` }];
  if (a && a.agents.length) {
    log.push({ tag: "adk", text: `InMemoryRunner app=hugin  SequentialAgent=hugin_understanding  agents=[${a.agents.join(" → ")}]  model=${a.model}` });
    if (!a.toolCalls.length) log.push({ tag: "investigator", text: "no tool calls needed" });
    for (const c of a.toolCalls) {
      log.push({ tag: "investigator", text: `tool_call   ${c.name}(${pretty(c.args)})` });
      log.push({ tag: "investigator", text: `tool_result ${c.name} → ${pretty(c.result)}`, tone: "ok" });
    }
    if (a.modelReading) log.push({ tag: "classifier", text: `structured output → intent=${a.modelReading.intent} sentiment=${a.modelReading.sentiment} confidence=${a.modelReading.confidence.toFixed(2)}` });
    if (a.modelError) log.push({ tag: "adk", text: `model unavailable, falling back to rules: ${a.modelError}`, tone: "err" });
  } else {
    log.push({ tag: "adk", text: a ? "Gemini not used for this message, rules only" : "no ADK record for this run (a seeded sample, or recorded before ADK logging), showing the decision trail only", tone: "warn" });
  }
  if (a) {
    log.push({ tag: "rules", text: `safety-net reading → intent=${a.rulesReading.intent} sentiment=${a.rulesReading.sentiment} confidence=${a.rulesReading.confidence.toFixed(2)}` });
    if (a.modelReading) {
      log.push(a.overridden
        ? { tag: "merge", text: `model said ${a.modelReading.intent}, rules said ${a.rulesReading.intent} → keeping the MORE CAUTIOUS reading`, tone: "warn" }
        : { tag: "merge", text: `model and rules agree on ${t.intent} (model reading kept)`, tone: "ok" });
    }
    log.push({ tag: "adk", text: `understanding finished in ${a.understandMs} ms · source=${t.source}` });
  }
  log.push({ tag: "policy", text: `${t.policyId} → ${human(t.action)}: ${t.policy}  (deterministic engine, the model cannot override it)`, tone: t.action === "safety_and_escalate" ? "warn" : "ok" });
  for (const s of t.steps.filter((x) => x.label === "Checked" || x.label === "Retrieved" || x.label === "Acted")) {
    log.push({ tag: s.label === "Acted" ? "action" : s.label.toLowerCase(), text: s.detail, tone: s.tone });
  }
  log.push({ tag: "done", text: `total ${(t.latencyMs / 1000).toFixed(2)}s · confidence ${t.confidence.toFixed(2)} · ${t.summary}`, tone: "ok" });
  return log;
}

const TAG_COLOR: Record<string, string> = {
  inbound: "#7DD3FC", adk: "#C4B5FD", investigator: "#F9A8D4", classifier: "#FDBA74", rules: "#A7F3D0", merge: "#FCD34D",
  policy: "#93C5FD", action: "#86EFAC", checked: "#A7F3D0", retrieved: "#A7F3D0", done: "#86EFAC",
  collect: "#7DD3FC", classify: "#FDBA74", aggregate: "#93C5FD", drivers: "#FCD34D", risk: "#FCA5A5", links: "#F9A8D4", why: "#C4B5FD",
};
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
const TONE_COLOR = { ok: "#E2E8F0", warn: "#FCD34D", err: "#FCA5A5" };

function Stage({ n, icon, title, sub, children }: { n: number; icon: ReactNode; title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="row" style={{ marginBottom: 10, gap: 10 }}>
        <span className="badge b-acc mono">{n}</span>
        {icon}
        <b style={{ fontSize: 14 }}>{title}</b>
        {sub && <span className="faint" style={{ fontSize: 12 }}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

const Reading = ({ r, label }: { r: { intent: string; sentiment: string; confidence: number }; label: string }) => (
  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
    <span className="faint" style={{ fontSize: 12, width: 88 }}>{label}</span>
    <span className="chip">intent · {human(r.intent)}</span>
    <span className="chip">{r.sentiment}</span>
    <ConfidenceBadge v={r.confidence} />
  </div>
);

function RunDetail({ run, conv, customer }: { run: Run; conv?: WithId<Conversation>; customer?: WithId<Customer> }) {
  const { t } = run;
  const a = t.adk;
  const msgs = useCollection<Message>(`conversations/${run.convId}/messages`, { order: ["at", "asc"] }).data;
  const inbound = msgs.find((m) => m.id === t.afterMsg);
  const reply = msgs.find((m) => m.dir === "out" && m.author === "ai" && inbound && m.at >= inbound.at && m.at <= t.at + 5000);
  const who = customer?.name ?? "customer";
  const channelLabel = conv ? CHANNELS[conv.channel]?.label ?? conv.channel : "channel";
  const msgText = inbound ? inbound.transcript || inbound.text : "";
  const acted = t.steps.find((s) => s.label === "Acted");
  const log = useMemo(() => buildLog(run, who, channelLabel, msgText), [run, who, channelLabel, msgText]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Stage n={1} icon={<Activity size={15} />} title="Message received" sub={`${clock(t.at - t.latencyMs)} · ${channelLabel}`}>
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>{conv && <ChannelBadge ch={conv.channel} />}<b style={{ fontWeight: 500 }}>{who}</b></div>
        <div style={{ background: "var(--sunken)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 }}>{msgText || <span className="faint">(message text not available)</span>}</div>
      </Stage>

      <Stage n={2} icon={<Brain size={15} />} title="Agent Development Kit · understanding" sub="SequentialAgent: investigator → classifier">
        {a && a.agents.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="badge b-acc">Gemini</span><span className="chip mono">{a.model}</span><span className="chip">{a.understandMs} ms</span>
            </div>
            <div>
              <div className="row" style={{ gap: 6, marginBottom: 6 }}><Bot size={14} /><b style={{ fontWeight: 500, fontSize: 13 }}>investigator</b><span className="faint" style={{ fontSize: 12 }}>LlmAgent · chooses read-only tools</span></div>
              {a.toolCalls.length === 0 && <div className="faint" style={{ fontSize: 12.5 }}>Gemini decided no tool was needed.</div>}
              {a.toolCalls.map((c, i) => (
                <div key={i} style={{ background: "var(--sunken)", borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontSize: 12 }}>
                  <div className="row" style={{ gap: 6 }}><Wrench size={12} /><b className="mono" style={{ fontWeight: 600 }}>{c.name}</b><span className="badge b-out">read-only</span></div>
                  <div className="mono faint" style={{ marginTop: 4, wordBreak: "break-word" }}>args {pretty(c.args)}</div>
                  <div className="mono" style={{ marginTop: 2, wordBreak: "break-word" }}>→ {pretty(c.result)}</div>
                </div>
              ))}
            </div>
            <div>
              <div className="row" style={{ gap: 6, marginBottom: 6 }}><Bot size={14} /><b style={{ fontWeight: 500, fontSize: 13 }}>classifier</b><span className="faint" style={{ fontSize: 12 }}>LlmAgent · structured output</span></div>
              {a.modelReading ? <Reading r={a.modelReading} label="Gemini says" /> : <div className="faint" style={{ fontSize: 12.5 }}>{a.modelError ? `Model unavailable: ${a.modelError}` : "No model reading."}</div>}
            </div>
          </div>
        ) : (
          <div className="faint" style={{ fontSize: 13 }}>{a ? "Gemini was not used for this message. The rule-based reading decided." : conv?.sample ? "This is a seeded sample conversation, so it shows the decision trail only. Message the live Telegram bot, or send one from Demo control, to see the full ADK trail." : "This run was recorded before ADK logging was added. Send a new message to see the full ADK trail."}</div>
        )}
      </Stage>

      <Stage n={3} icon={<ShieldCheck size={15} />} title="Safety net" sub="rules can only make the outcome more cautious">
        {a ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Reading r={a.rulesReading} label="Rules say" />
            {a.modelReading && (
              <div className="row" style={{ gap: 6 }}>
                <span className={"badge " + (a.overridden ? "b-warn" : "b-ok")}>{a.overridden ? <CircleAlert /> : <Check />}{a.overridden ? "Rules raised the risk level" : "Model and rules agree"}</span>
                <span className="faint" style={{ fontSize: 12.5 }}>final intent · {human(t.intent)}</span>
              </div>
            )}
          </div>
        ) : <span className="faint" style={{ fontSize: 13 }}>Final intent · {human(t.intent)}</span>}
      </Stage>

      <Stage n={4} icon={<ShieldCheck size={15} />} title="Policy engine" sub="deterministic code, not the model">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="badge b-n mono">{t.policyId}</span>
          <span className={"badge " + (t.action === "safety_and_escalate" ? "b-err" : t.action === "auto_send" ? "b-ok" : "b-warn")}>{human(t.action)}</span>
          <ConfidenceBadge v={t.confidence} />
        </div>
        <div style={{ fontSize: 13.5, marginTop: 8 }}>{t.policy}</div>
      </Stage>

      <Stage n={5} icon={<Wrench size={15} />} title="Actions and reply" sub={`${(t.latencyMs / 1000).toFixed(1)}s end to end`}>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {t.tools.length ? t.tools.map((x) => <span key={x} className="chip mono">{x}</span>) : <span className="faint" style={{ fontSize: 12.5 }}>no tools executed</span>}
        </div>
        {acted && <div className="faint" style={{ fontSize: 12.5, marginBottom: 8 }}>{acted.detail}</div>}
        {reply && <div style={{ background: "var(--a50)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 }}><span className="faint" style={{ fontSize: 11.5 }}>HUGIN reply · </span>{reply.text}</div>}
      </Stage>

      <div className="card" style={{ padding: 0, overflow: "hidden", background: "#0F1419" }}>
        <div className="row" style={{ padding: "8px 14px", borderBottom: "1px solid #243040", color: "#94A3B8", fontSize: 12 }}>
          <b style={{ fontWeight: 500, color: "#E2E8F0" }}>Agent log</b>
          <span>ADK run reconstructed from the recorded trace</span>
        </div>
        <div className="mono" style={{ padding: "10px 14px", fontSize: 12, lineHeight: 1.65, maxHeight: 360, overflowY: "auto" }}>
          {log.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 10 }}>
              <span style={{ color: TAG_COLOR[l.tag] ?? "#94A3B8", width: 92, flex: "none" }}>[{l.tag}]</span>
              <span style={{ color: TONE_COLOR[l.tone ?? "ok"], wordBreak: "break-word" }}>{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Social insights reasoning: how a campaign's or a post's sentiment is built. There is no extra AI call here;
 * the numbers are aggregated, transparently, from Gemini's reading of each comment.
 */
function InsightRuns() {
  const { data: comments, loading } = useCollection<Comment>("comments", { order: ["at", "desc"] });
  const { data: posts } = useCollection<Post>("posts");
  const [sel, setSel] = useState<string | null>(null);
  const postsByKey = useMemo(() => new Map(posts.map((p) => [p.id, p])), [posts]);
  const keyOf = (c: Comment) => `${c.platform}_${c.postId}`;
  const campaignOf = (c: Comment) => postsByKey.get(keyOf(c))?.campaign || UNTAGGED;

  const groups = [...CAMPAIGNS, UNTAGGED]
    .map((name) => ({ name, posts: posts.filter((p) => (p.campaign || UNTAGGED) === name).filter((p) => comments.some((c) => keyOf(c) === p.id)) }))
    .filter((g) => g.posts.length);
  const current = sel ?? (groups[0] ? `c:${groups[0].name}` : null);
  const isPost = current?.startsWith("p:");
  const target = current?.slice(2) ?? "";
  const scope = comments.filter((c) => (isPost ? keyOf(c) === target : campaignOf(c) === target));
  const title = isPost ? postsByKey.get(target)?.label ?? target : target;

  const n = scope.length;
  const net = n ? scope.reduce((a, c) => a + c.score, 0) / n : 0;
  const bySent = (["positive", "neutral", "mixed", "negative"] as const).map((s) => [s, scope.filter((c) => c.sentiment === s).length] as const);
  const byGemini = scope.filter((c) => c.source === "gemini").length;
  const topics = [...scope.reduce((m, c) => (c.topic && c.topic !== "other" ? m.set(c.topic, (m.get(c.topic) ?? 0) + 1) : m), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const sorted = [...scope].sort((a, b) => a.score - b.score);
  const down = sorted.filter((c) => c.score < 0).slice(0, 3);
  const up = [...sorted].reverse().filter((c) => c.score > 0).slice(0, 3);
  const risky = scope.filter((c) => c.riskFlag);
  const platforms = [...scope.reduce((m, c) => m.set(c.platform, (m.get(c.platform) ?? 0) + 1), new Map<string, number>())];

  const log: LogLine[] = useMemo(() => {
    if (!n) return [];
    const l: LogLine[] = [{ tag: "collect", text: `${n} comments on ${isPost ? "this post" : `${new Set(scope.map(keyOf)).size} post${new Set(scope.map(keyOf)).size === 1 ? "" : "s"} in "${target}"`} · ${platforms.map(([p, k]) => `${PLATFORMS[p as keyof typeof PLATFORMS]?.label ?? p} ${k}`).join(", ")}` }];
    for (const c of scope.slice(0, 10)) l.push({ tag: "classify", text: `${c.source === "gemini" ? "Gemini" : "rules "} ${c.author}: ${c.sentiment} ${signed(c.score)} · topic=${c.topic} · intent=${c.intent}${c.sarcasm ? " · sarcasm" : ""}`, tone: c.source === "gemini" ? "ok" : "warn" });
    if (n > 10) l.push({ tag: "classify", text: `… and ${n - 10} more` });
    l.push({ tag: "aggregate", text: `net sentiment = average of scores = ${scope.reduce((a, c) => a + c.score, 0).toFixed(2)} / ${n} = ${signed(net)}` });
    l.push({ tag: "aggregate", text: `split ${bySent.map(([s, k]) => `${s} ${k}`).join(" · ")} · topics ${topics.slice(0, 3).map(([t, k]) => `${t} ${k}`).join(", ") || "none"}` });
    if (down[0]) l.push({ tag: "drivers", text: `pulling down: ${down[0].author} (${signed(down[0].score)}) "${down[0].text.slice(0, 70)}"`, tone: "warn" });
    if (up[0]) l.push({ tag: "drivers", text: `lifting up: ${up[0].author} (${signed(up[0].score)}) "${up[0].text.slice(0, 70)}"` });
    l.push(risky.length ? { tag: "risk", text: `${risky.length} risky: ${risky.slice(0, 3).map((c) => `${human(c.intent)} (${c.author})`).join(", ")}`, tone: "warn" } : { tag: "risk", text: "no risky comments" });
    l.push({ tag: "done", text: `${byGemini} of ${n} comments read by Gemini; the rest by the rule-based fallback`, tone: byGemini === n ? "ok" : "warn" });
    return l;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, comments, posts]);

  if (loading) return <Loading />;
  if (!current) return <Empty icon={Activity} title="No comments yet">Comments appear here once they are classified.</Empty>;
  const row = (on: boolean): React.CSSProperties => ({ display: "block", width: "100%", textAlign: "left", border: 0, cursor: "pointer", padding: "8px 12px", borderRadius: 10, background: on ? "var(--a50)" : "none", boxShadow: on ? "inset 2px 0 0 var(--accent)" : "none", font: "inherit", color: "inherit" });
  const quote = (c: Comment) => (
    <div key={c.author + c.at} style={{ background: "var(--sunken)", borderRadius: 8, padding: "7px 10px", fontSize: 12.5 }}>
      <span className="mono" style={{ color: c.score < 0 ? "var(--err, #D93F3F)" : "var(--ok, #17763F)" }}>{signed(c.score)}</span> <b style={{ fontWeight: 500 }}>{c.author}</b> <span className="faint">&ldquo;{c.text.length > 110 ? `${c.text.slice(0, 110)}…` : c.text}&rdquo;</span>
    </div>
  );

  return (
    <>
      <div className="g-stats">
        <Stat label="Comments" value={n} sub={isPost ? "on this post" : "in this campaign"} />
        <Stat label="Net sentiment" value={<span style={{ color: net >= 0 ? "var(--ok, #17763F)" : "var(--err, #D93F3F)" }}>{signed(net)}</span>} sub="average score, −1 to +1" />
        <Stat label="Read by Gemini" value={`${n ? Math.round((byGemini / n) * 100) : 0}%`} sub={`${byGemini} of ${n}`} />
        <Stat label="Risky" value={risky.length} sub="scams, fraud reports, threats" />
      </div>
      <div className="g-side g-side-300">
        <div className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {groups.map((g) => (
            <div key={g.name}>
              <button onClick={() => setSel(`c:${g.name}`)} style={{ ...row(current === `c:${g.name}`), fontWeight: 600, fontSize: 13 }}>{g.name}</button>
              {g.posts.map((p) => (
                <button key={p.id} onClick={() => setSel(`p:${p.id}`)} style={{ ...row(current === `p:${p.id}`), paddingLeft: 22, fontSize: 12.5 }}>
                  <span className="dot" style={{ background: PLATFORMS[p.platform]?.color }} /> {p.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Stage n={1} icon={<Activity size={15} />} title={`Collected · ${title}`} sub={isPost ? "one post" : "every post tagged with this campaign"}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {platforms.map(([p, k]) => <span key={p} className="chip"><span className="dot" style={{ background: PLATFORMS[p as keyof typeof PLATFORMS]?.color }} />{PLATFORMS[p as keyof typeof PLATFORMS]?.label ?? p} · {k}</span>)}
            </div>
          </Stage>
          <Stage n={2} icon={<Brain size={15} />} title="Each comment read by Gemini" sub="sentiment, score, topic and intent per comment, through the Agent Development Kit">
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
              {sorted.map((c) => (
                <div key={c.author + c.at} className="row" style={{ gap: 6, fontSize: 12.5 }}>
                  <span className={"badge " + (c.source === "gemini" ? "b-acc" : "b-n")}>{c.source === "gemini" ? "Gemini" : "Rules"}</span>
                  <SentimentBadge s={c.sentiment} sarcasm={c.sarcasm} />
                  <span className="mono" style={{ width: 44 }}>{signed(c.score)}</span>
                  <span className="chip">{human(c.topic)}</span>
                  <span className="ellipsis faint">{c.author}: {c.text}</span>
                </div>
              ))}
            </div>
          </Stage>
          <Stage n={3} icon={<Wrench size={15} />} title="Aggregated" sub="plain arithmetic, no model: the same inputs always give the same score">
            <div className="mono" style={{ fontSize: 12.5 }}>net = {scope.reduce((a, c) => a + c.score, 0).toFixed(2)} ÷ {n} = <b style={{ color: net >= 0 ? "var(--ok, #17763F)" : "var(--err, #D93F3F)" }}>{signed(net)}</b></div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {bySent.map(([s, k]) => <span key={s} className="chip">{s} · {k} ({n ? Math.round((k / n) * 100) : 0}%)</span>)}
              {topics.slice(0, 4).map(([t, k]) => <span key={t} className="chip">topic {human(t)} · {k}</span>)}
            </div>
          </Stage>
          <Stage n={4} icon={<ShieldCheck size={15} />} title="What drives the score" sub="the comments with the strongest scores">
            <div style={{ display: "grid", gap: 6 }}>
              {down.length > 0 && <div className="faint" style={{ fontSize: 12 }}>Pulling it down</div>}
              {down.map(quote)}
              {up.length > 0 && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Lifting it up</div>}
              {up.map(quote)}
            </div>
          </Stage>
          <Stage n={5} icon={<CircleAlert size={15} />} title="Risk" sub="flagged by the comment classifier, sent to Moderation">
            {risky.length ? risky.map((c) => <div key={c.author + c.at} style={{ fontSize: 12.5, marginBottom: 4 }}><span className="badge b-err">{human(c.intent)}</span> <b style={{ fontWeight: 500 }}>{c.author}</b> <span className="faint">{c.riskReason}</span></div>) : <span className="faint" style={{ fontSize: 12.5 }}>No risky comments.</span>}
          </Stage>
          <LogPanel title="Insight log" sub="how this score was built" lines={log} />
        </div>
      </div>
    </>
  );
}

function LogPanel({ title, sub, lines }: { title: string; sub: string; lines: LogLine[] }) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", background: "#0F1419" }}>
      <div className="row" style={{ padding: "8px 14px", borderBottom: "1px solid #243040", color: "#94A3B8", fontSize: 12 }}>
        <b style={{ fontWeight: 500, color: "#E2E8F0" }}>{title}</b><span>{sub}</span>
      </div>
      <div className="mono" style={{ padding: "10px 14px", fontSize: 12, lineHeight: 1.65, maxHeight: 360, overflowY: "auto" }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 10 }}>
            <span style={{ color: TAG_COLOR[l.tag] ?? "#94A3B8", width: 92, flex: "none" }}>[{l.tag}]</span>
            <span style={{ color: TONE_COLOR[l.tone ?? "ok"], wordBreak: "break-word" }}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Plain-language reasons for each moderation decision, derived from the stored classification. */
function whyLines(c: Comment): string[] {
  const w: string[] = [];
  if (c.riskFlag) w.push(`Flagged as risky: ${c.riskReason || human(c.intent)}.`);
  if (c.suggestHide) w.push("Hide recommended: scams, spam and lookalike links are hidden so other customers don't click them. A person confirms.");
  if (c.intent === "scam_or_spam") w.push("No reply drafted: the agent never engages with scams or spam.");
  else if (c.needsReply) w.push(c.draft ? `Needs a reply: a draft is ready${c.draftCite ? `, grounded in ${c.draftCite.doc} ${c.draftCite.section}` : ""}, waiting for a person to approve.` : "Needs a reply: no approved source matched, so a person writes it.");
  else w.push("No reply needed.");
  if (c.sarcasm) w.push("Sarcasm detected: positive words, negative meaning, so it is scored as negative.");
  return w;
}

/** Comment moderation runs, read straight from the classified comments (each one records which engine read it). */
function CommentRuns() {
  const comments = useCollection<Comment>("comments", { order: ["at", "desc"], limit: 12 });
  const [sel, setSel] = useState<string | null>(null);
  const rows = comments.data;
  const selected = rows.find((c) => c.id === sel) ?? rows[0];
  const logLines = useMemo<LogLine[]>(() => {
    if (!selected) return [];
    const c = selected;
    const lines: LogLine[] = [
      { tag: "inbound", text: `comment by ${c.author} on "${c.postLabel}" (${PLATFORMS[c.platform]?.label ?? c.platform}): "${c.text.slice(0, 160)}"` },
      c.source === "gemini"
        ? { tag: "classifier", text: `Gemini via ADK → sentiment=${c.sentiment} (${c.score.toFixed(2)}) emotion=${c.emotion} topic=${c.topic} intent=${c.intent} sarcasm=${c.sarcasm} toxicity=${c.toxicity.toFixed(2)}` }
        : { tag: "rules", text: `rule-based reading → sentiment=${c.sentiment} (${c.score.toFixed(2)}) topic=${c.topic} intent=${c.intent}${c.sample ? "  (seeded sample, classified without a model)" : ""}`, tone: "warn" },
      ...(c.urls?.length ? [{ tag: "links", text: `links found: ${c.urls.join(", ")}${/lookalike/i.test(c.riskReason) ? " → lookalike of the bank's domain" : ""}`, tone: /lookalike/i.test(c.riskReason) ? "warn" as const : "ok" as const }] : []),
      { tag: "merge", text: "safety net: rules and model are merged and the more cautious reading wins" },
      c.riskFlag
        ? { tag: "policy", text: `RISK: ${c.riskReason || human(c.intent)}${c.suggestHide ? "  → hiding recommended" : ""}`, tone: "warn" }
        : { tag: "policy", text: "no risk flag raised", tone: "ok" },
      { tag: "action", text: c.draft ? `reply drafted for a human to approve${c.draftCite ? ` · cites ${c.draftCite.doc} ${c.draftCite.section}` : ""}` : c.needsReply ? "needs a reply, no approved source for an automatic draft" : "no reply needed", tone: "ok" },
    ];
    for (const w of whyLines(c)) lines.push({ tag: "why", text: w });
    if (c.reply) lines.push({ tag: "done", text: `reply sent by ${c.reply.by}`, tone: "ok" });
    return lines;
  }, [selected]);

  if (comments.loading) return <Loading />;
  if (!selected) return <Empty icon={Activity} title="No comments yet">Post a comment from Demo control and it appears here.</Empty>;
  const c = selected;
  const viaGemini = rows.filter((x) => x.source === "gemini").length;
  return (
    <>
      <div className="g-stats">
        <Stat label="Recent comments" value={rows.length} sub="latest 12" />
        <Stat label="Read by Gemini" value={`${Math.round((viaGemini / rows.length) * 100)}%`} sub={`${viaGemini} of ${rows.length}`} />
        <Stat label="Flagged as risky" value={rows.filter((x) => x.riskFlag).length} sub="scams, fraud reports, threats" />
        <Stat label="Hide suggested" value={rows.filter((x) => x.suggestHide).length} sub="a human confirms" />
      </div>
      <div className="g-side g-side-340">
        <div className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {rows.map((r) => (
            <button key={r.id} onClick={() => setSel(r.id)} style={{ display: "block", width: "100%", textAlign: "left", border: 0, cursor: "pointer", padding: "10px 12px", borderRadius: 10, background: r.id === c.id ? "var(--a50)" : "none", boxShadow: r.id === c.id ? "inset 2px 0 0 var(--accent)" : "none", font: "inherit", color: "inherit" }}>
              <div className="row" style={{ gap: 6 }}>
                <b style={{ fontWeight: 500, fontSize: 13.5 }}>{r.author}</b>
                <span className={"badge " + (r.source === "gemini" ? "b-acc" : "b-n")}>{r.source === "gemini" ? "Gemini" : "Rules"}</span>
                <span className="faint" style={{ marginLeft: "auto", fontSize: 11.5 }}>{timeAgo(r.at)}</span>
              </div>
              <div style={{ fontSize: 12.5, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.text}</div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>{human(r.intent)}{r.riskFlag ? " · risky" : ""} · {PLATFORMS[r.platform]?.label ?? r.platform}</div>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Stage n={1} icon={<Activity size={15} />} title="Comment received" sub={`${clock(c.at)} · ${PLATFORMS[c.platform]?.label ?? c.platform} · ${c.postLabel}`}>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}><b style={{ fontWeight: 500 }}>{c.author}</b>{c.sample && <span className="badge b-sample">SAMPLE</span>}</div>
            <div style={{ background: "var(--sunken)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 }}>{c.text}</div>
          </Stage>
          <Stage n={2} icon={<Brain size={15} />} title="Classification" sub={c.source === "gemini" ? "Gemini through the Agent Development Kit, structured output" : "rule-based reading"}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className={"badge " + (c.source === "gemini" ? "b-acc" : "b-n")}>{c.source === "gemini" ? "Gemini" : "Rules"}</span>
              <SentimentBadge s={c.sentiment} sarcasm={c.sarcasm} />
              <span className="chip mono">score {c.score.toFixed(2)}</span>
              <span className="chip">emotion · {c.emotion}</span>
              <span className="chip">topic · {c.topic}</span>
              <span className="chip">intent · {human(c.intent)}</span>
              <span className="chip">toxicity {c.toxicity.toFixed(2)}</span>
            </div>
            {c.source !== "gemini" && c.sample && <div className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Seeded sample data is classified without a model. Comments posted from Demo control or arriving live are read by Gemini.</div>}
          </Stage>
          <Stage n={3} icon={<ShieldCheck size={15} />} title="Risk decision" sub="rules and model merged, the more cautious reading wins">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className={"badge " + (c.riskFlag ? "b-err" : "b-ok")}>{c.riskFlag ? <CircleAlert /> : <Check />}{c.riskFlag ? "Risky" : "No risk flag"}</span>
              {c.suggestHide && <span className="badge b-warn">Hide recommended</span>}
              <span className={"badge " + (c.needsReply ? "b-info" : "b-n")}>{c.needsReply ? "Needs reply" : "No reply needed"}</span>
              <span className="badge b-out">{c.status}</span>
            </div>
            {c.riskReason && <div style={{ fontSize: 13.5, marginTop: 8 }}>{c.riskReason}</div>}
            {c.urls && c.urls.length > 0 && <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}><span className="faint" style={{ fontSize: 12 }}>Links checked</span>{c.urls.map((u) => <span key={u} className={"chip mono" + (/lookalike/i.test(c.riskReason) ? "" : "")} style={/lookalike/i.test(c.riskReason) ? { background: "var(--err-bg)", color: "var(--err-fg)" } : undefined}>{u}</span>)}</div>}
            <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12.5, color: "var(--text-2)" }}>{whyLines(c).map((w) => <li key={w}>{w}</li>)}</ul>
          </Stage>
          <Stage n={4} icon={<Wrench size={15} />} title="Drafted reply" sub="a human approves before anything is posted">
            {c.draft ? (
              <div style={{ background: "var(--a50)", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 }}>
                {c.draft}
                {c.draftCite && <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Source · {c.draftCite.doc} {c.draftCite.section}</div>}
              </div>
            ) : <span className="faint" style={{ fontSize: 13 }}>No automatic draft: {c.riskFlag ? "the agent does not engage with risky comments, it recommends hiding or reporting." : "no approved source matched."}</span>}
          </Stage>
          <div className="card" style={{ padding: 0, overflow: "hidden", background: "#0F1419" }}>
            <div className="row" style={{ padding: "8px 14px", borderBottom: "1px solid #243040", color: "#94A3B8", fontSize: 12 }}>
              <b style={{ fontWeight: 500, color: "#E2E8F0" }}>Agent log</b><span>reconstructed from the recorded classification</span>
            </div>
            <div className="mono" style={{ padding: "10px 14px", fontSize: 12, lineHeight: 1.65 }}>
              {logLines.map((l, i) => (
                <div key={i} style={{ display: "flex", gap: 10 }}>
                  <span style={{ color: TAG_COLOR[l.tag] ?? "#94A3B8", width: 92, flex: "none" }}>[{l.tag}]</span>
                  <span style={{ color: TONE_COLOR[l.tone ?? "ok"], wordBreak: "break-word" }}>{l.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** `/agent?run=<traceId>` opens that run, so other screens can link straight to a replay. */
export default function AgentConsolePage() {
  return (
    <Suspense fallback={<Loading />}>
      <AgentConsole />
    </Suspense>
  );
}

function AgentConsole() {
  useTick();
  const params = useSearchParams();
  const convs = useCollection<Conversation>("conversations", { order: ["lastAt", "desc"], limit: 8 });
  const customers = useCollection<Customer>("customers").data;
  const runs = useRuns(convs.data.map((c) => c.id));
  const [sel, setSel] = useState<string | null>(params.get("run"));
  const [tab, setTab] = useState<"messages" | "moderation" | "insights">("messages");
  if (convs.loading) return <Loading />;

  const selected = runs.find((r) => r.t.id === sel) ?? runs[0];
  const viaGemini = runs.filter((r) => r.t.source === "gemini").length;
  const avg = runs.length ? runs.reduce((n, r) => n + r.t.latencyMs, 0) / runs.length / 1000 : 0;
  const toolRuns = runs.reduce((n, r) => n + (r.t.adk?.toolCalls.length ?? 0), 0);
  const convOf = (id: string) => convs.data.find((c) => c.id === id);
  const custOf = (c?: Conversation) => customers.find((x) => x.id === c?.customerId);

  return (
    <>
      <Topbar title="Agent console" />
      <div className="page page-narrow" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
          Every message goes through the same pipeline: Gemini reads it with the Agent Development Kit, a rule-based safety net can only raise the risk, a deterministic policy engine decides, then the agent acts. Pick a run to replay it.
        </p>
        <div className="row" style={{ gap: 8 }}>
          {([["messages", "Customer messages"], ["moderation", "Moderation"], ["insights", "Social insights"]] as const).map(([k, label]) => (
            <button key={k} className="chip" onClick={() => setTab(k)} style={{ cursor: "pointer", border: 0, fontSize: 13, padding: "6px 14px", background: tab === k ? "var(--accent)" : undefined, color: tab === k ? "#fff" : undefined }}>{label}</button>
          ))}
        </div>
        {tab === "moderation" ? <CommentRuns /> : tab === "insights" ? <InsightRuns /> : (<>
        <div className="g-stats">
          <Stat label="Recent runs" value={runs.length} sub="latest 8 conversations" />
          <Stat label="Understood by Gemini" value={runs.length ? `${Math.round((viaGemini / runs.length) * 100)}%` : "–"} sub={`${viaGemini} of ${runs.length}`} />
          <Stat label="Avg end-to-end" value={`${avg.toFixed(1)}s`} sub="message in to action out" />
          <Stat label="ADK tool calls" value={toolRuns} sub="read-only, chosen by Gemini" />
        </div>
        {runs.length === 0 || !selected ? (
          <Empty icon={Activity} title="No agent runs yet">Send a simulated message from Demo control and watch it appear here.</Empty>
        ) : (
          <div className="g-side g-side-340">
            <div className="card" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {runs.map((r) => {
                const c = convOf(r.convId);
                const cu = custOf(c);
                return (
                  <button key={r.t.id} onClick={() => setSel(r.t.id)} style={{ display: "block", width: "100%", textAlign: "left", border: 0, cursor: "pointer", padding: "10px 12px", borderRadius: 10, background: r.t.id === selected.t.id ? "var(--a50)" : "none", boxShadow: r.t.id === selected.t.id ? "inset 2px 0 0 var(--accent)" : "none", font: "inherit", color: "inherit" }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b style={{ fontWeight: 500, fontSize: 13.5 }}>{cu?.name ?? "Customer"}</b>
                      <span className={"badge " + (r.t.source === "gemini" ? "b-acc" : "b-n")}>{r.t.source === "gemini" ? "Gemini" : "Rules"}</span>
                      <span className="faint" style={{ marginLeft: "auto", fontSize: 11.5 }}>{timeAgo(r.t.at)}</span>
                    </div>
                    <div className="faint" style={{ fontSize: 12.5, marginTop: 3 }}>{r.t.summary}</div>
                    <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>{human(r.t.intent)} · {r.t.policyId} · {(r.t.latencyMs / 1000).toFixed(1)}s</div>
                  </button>
                );
              })}
            </div>
            <RunDetail run={selected} conv={convOf(selected.convId)} customer={custOf(convOf(selected.convId))} />
          </div>
        )}
        </>)}
      </div>
    </>
  );
}
