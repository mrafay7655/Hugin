"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, Bot, CircleAlert, CircleCheck, CircleDashed, CircleX, Cpu, Plug, ShieldCheck, Timer, type LucideIcon } from "lucide-react";
import { useCollection } from "@/lib/data";
import type { AgentHealth, DayMetrics } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Loading, Stat, ago, useTick, within } from "@/components/ui";

type Range = "today" | "week";
const DAY = 24 * 3600_000;
const TELEGRAM_DAILY_LIMIT = 1500;

interface AgentInfo { id: string; name: string; kind: string; icon: LucideIcon; what: string; numbers: (m: DayMetrics) => [string, string][] }

const pct = (a = 0, b = 0) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const secs = (sum = 0, n = 0) => (n ? `${(sum / n / 1000).toFixed(1)}s` : "–");
const n = (v = 0) => String(v);

const AGENTS: AgentInfo[] = [
  { id: "customer-agent", name: "Customer agent", kind: "AI agent · Google ADK", icon: Bot, what: "Investigator then classifier, Gemini 2.5 Flash. Reads every message, voice note and screenshot.",
    numbers: (m) => [["Messages", n(m.runs)], ["Read by Gemini", pct(m.understoodByGemini, m.runs)], ["Gemini time", secs(m.understandMsSum, m.runs)], ["Model errors", n(m.modelErrors)]] },
  { id: "comment-agent", name: "Comment agent", kind: "AI agent · Google ADK", icon: Bot, what: "Scores public comments for sentiment, sarcasm, topic and risk.",
    numbers: (m) => [["Comments", n(m.comments)], ["Read by Gemini", pct(m.commentsByGemini, m.comments)], ["Risky", n(m.commentsRisky)], ["Model errors", n(m.commentModelErrors)]] },
  { id: "policy-engine", name: "Policy engine", kind: "Deterministic code", icon: Cpu, what: "Decides what happens. The model only proposes.",
    numbers: (m) => [["Decisions", n(m.runs)], ["Fraud (P-07)", n(m.policy?.["P-07"])], ["Unconfirmed (P-05)", n(m.policy?.["P-05"])], ["Safe handoff (P-99)", n(m.policy?.["P-99"])]] },
  { id: "output-guard", name: "Output guard", kind: "Deterministic code", icon: ShieldCheck, what: "Checks every outgoing message for secrets, refund promises and bad links.",
    numbers: (m) => [["Messages sent", n(m.messagesSent)], ["Blocked", n(m.guardBlocks)], ["Blocked from the agent", n(m.guardBlocksAgent)], ["Blocked from people", n(m.guardBlocksPeople)]] },
  { id: "telegram", name: "Telegram connector", kind: "Channel", icon: Plug, what: "The live demo bot. Secret-header webhook, deduplicated, rate-limited.",
    numbers: (m) => [["Received", n(m.received?.telegram)], ["Over the limit", n(m.limited?.telegram)], ["Rejected", n(m.rejected?.telegram)], ["Daily cap used", pct(m.received?.telegram, TELEGRAM_DAILY_LIMIT)]] },
  { id: "whatsapp", name: "WhatsApp connector", kind: "Channel", icon: Plug, what: "Cloud API webhook, signed by Meta. The test number reaches registered phones only.",
    numbers: (m) => [["Received", n(m.received?.whatsapp)], ["Sent", n(m.sent?.whatsapp)], ["Rejected", n(m.rejected?.whatsapp)], ["", ""]] },
  { id: "meta-comments", name: "Meta comments connector", kind: "Channel", icon: Plug, what: "Instagram and Facebook comment webhooks, signed by Meta.",
    numbers: (m) => [["Live comments", n(m.commentsLive)], ["Rejected", n(m.rejected?.meta)], ["", ""], ["", ""]] },
  { id: "sweeper", name: "Sweeper", kind: "Background job · every 5 min", icon: Timer, what: "Re-runs any message whose run was lost, so nobody is left unanswered.",
    numbers: (m) => [["Picked up", n(m.sweptConversations)], ["", ""], ["", ""], ["", ""]] },
];

type Status = "healthy" | "degraded" | "failing" | "idle" | "none";
const STATUS: Record<Status, { label: string; cls: string; icon: LucideIcon }> = {
  healthy: { label: "Healthy", cls: "b-ok", icon: CircleCheck },
  degraded: { label: "Degraded", cls: "b-warn", icon: CircleAlert },
  failing: { label: "Failing", cls: "b-err", icon: CircleX },
  idle: { label: "Idle", cls: "b-n", icon: CircleDashed },
  none: { label: "No activity yet", cls: "b-n", icon: CircleDashed },
};

/** Healthy: worked in the last day and nothing has failed since. Degraded: the latest event is an error but it worked recently. Failing: errors and no success for a day. */
function statusOf(h?: AgentHealth): Status {
  if (!h || (!h.lastOkAt && !h.lastErrorAt)) return "none";
  const ok = h.lastOkAt ?? 0, err = h.lastErrorAt ?? 0;
  if (err > ok) return within(ok, DAY) ? "degraded" : "failing";
  return within(ok, DAY) ? "healthy" : "idle";
}

/** Adds the counters of several days (nested maps included). */
function sum(days: DayMetrics[]): DayMetrics {
  const out: Record<string, unknown> = { day: "" };
  for (const d of days) {
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === "number") out[k] = ((out[k] as number) ?? 0) + v;
      else if (v && typeof v === "object") {
        const into = ((out[k] as Record<string, number>) ??= {});
        for (const [kk, vv] of Object.entries(v as Record<string, number>)) if (typeof vv === "number") into[kk] = (into[kk] ?? 0) + vv;
      }
    }
  }
  return out as unknown as DayMetrics;
}

const lastDays = (count: number) => Array.from({ length: count }, (_, i) => new Date(Date.now() - (count - 1 - i) * DAY).toISOString().slice(0, 10));

export default function AgentsPage() {
  useTick(30000);
  const health = useCollection<AgentHealth>("health");
  const metrics = useCollection<DayMetrics>("metrics", { order: ["day", "desc"], limit: 7 });
  const [range, setRange] = useState<Range>("today");
  if (health.loading || metrics.loading) return <Loading />;

  const days = lastDays(7);
  const byDay = new Map(metrics.data.map((d) => [d.day ?? d.id, d]));
  const today: DayMetrics = byDay.get(days[6]) ?? { day: days[6] };
  const m: DayMetrics = range === "today" ? today : sum(days.map((d) => byDay.get(d) ?? { day: d }));
  const hById = new Map(health.data.map((h) => [h.id, h]));
  const statuses = AGENTS.map((a) => statusOf(hById.get(a.id)));
  const problems = statuses.filter((s) => s === "failing" || s === "degraded").length;
  const runs = m.runs ?? 0;
  const outcomes: [string, number][] = [
    ["Answered by the agent", m.action?.auto_send ?? 0],
    ["Drafted for a person", m.action?.draft ?? 0],
    ["Fraud: card locked, case opened", m.action?.safety_and_escalate ?? 0],
    ["Handed over: no approved source", m.action?.fallback ?? 0],
  ];

  return (
    <>
      <Topbar title="Agent dashboard">
        <div className="seg" role="group" aria-label="Time range">
          <button className={range === "today" ? "on" : ""} onClick={() => setRange("today")}>Today</button>
          <button className={range === "week" ? "on" : ""} onClick={() => setRange("week")}>7 days</button>
        </div>
      </Topbar>
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="banner" style={{ background: problems ? "var(--warn-bg)" : "var(--ok-bg)", color: problems ? "var(--warn-fg)" : "var(--ok-fg)", fontSize: 13.5 }}>
          {problems ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
          <span>
            <b style={{ fontWeight: 600 }}>{AGENTS.length} agents.</b> {statuses.filter((s) => s === "healthy").length} healthy, {problems} need attention, {statuses.filter((s) => s === "idle" || s === "none").length} idle.
            {" "}Numbers count real use only (live and simulated). Seeded sample data is not counted.
          </span>
        </div>

        <div className="g-stats">
          <Stat label="Messages handled" value={runs} sub={range === "today" ? "today" : "last 7 days"} />
          <Stat label="Answered by the agent" value={pct(m.action?.auto_send, runs)} sub="sent without a person" />
          <Stat label="Read by Gemini" value={pct(m.understoodByGemini, runs)} sub={`${m.modelErrors ?? 0} model error(s)`} />
          <Stat label="Time to first reply" value={secs(m.firstReplyMsSum, m.repliesSent)} sub="message in to reply out" />
          <Stat label="Fraud cases opened" value={m.casesOpened ?? 0} sub={`${m.cardsLocked ?? 0} card(s) locked, ${m.cardsUnlocked ?? 0} unlocked`} />
          <Stat label="Blocked by the guard" value={m.guardBlocks ?? 0} sub="unsafe messages never sent" />
          <Stat label="Rules overrode Gemini" value={m.rulesOverrodeModel ?? 0} sub="kept the more cautious reading" />
          <Stat label="Comments scored" value={m.comments ?? 0} sub={`${m.commentsRisky ?? 0} risky`} />
        </div>

        <div className="g-side g-side-340">
          <div className="card">
            <h3>Messages per day</h3>
            <DayBars days={days} values={days.map((d) => byDay.get(d)?.runs ?? 0)} />
          </div>
          <div className="card">
            <h3>What happened to each message</h3>
            {runs === 0 && <div className="faint" style={{ fontSize: 13 }}>No messages yet in this range. Try one from <Link href="/try" style={{ textDecoration: "underline" }}>Try it live</Link>.</div>}
            {runs > 0 && outcomes.map(([label, v]) => <Meter key={label} label={label} value={v} total={runs} />)}
          </div>
        </div>

        <div>
          <div className="row" style={{ justifyContent: "space-between", margin: "4px 0 10px", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>Agents</h3>
            <Link href="/agent" className="btn ghost sm"><Activity size={14} />Replay individual runs</Link>
          </div>
          <div className="agents-grid">
            {AGENTS.map((a, i) => <AgentCard key={a.id} a={a} h={hById.get(a.id)} status={statuses[i]} m={m} />)}
          </div>
        </div>
      </div>
    </>
  );
}

function AgentCard({ a, h, status, m }: { a: AgentInfo; h?: AgentHealth; status: Status; m: DayMetrics }) {
  const st = STATUS[status];
  const numbers = a.numbers(m).filter(([label]) => label);
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }} data-agent={a.id}>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <a.icon size={18} style={{ marginTop: 2 }} />
        <div className="grow">
          <b>{a.name}</b>
          <div className="faint" style={{ fontSize: 12 }}>{a.kind}</div>
        </div>
        <span className={"badge " + st.cls}><st.icon />{st.label}</span>
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>{a.what}</div>
      <div className="agent-nums">
        {numbers.map(([label, value]) => (
          <div key={label}><div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{value}</div><div className="faint" style={{ fontSize: 11.5 }}>{label}</div></div>
        ))}
      </div>
      <div className="faint" style={{ fontSize: 12, borderTop: "1px solid var(--n100)", paddingTop: 8 }}>
        {h?.lastOkAt ? <>Last worked {ago(h.lastOkAt)}{h.lastDetail ? ` · ${h.lastDetail}` : ""}</> : "Has not run yet"}
        {h?.lastErrorAt && (
          <div style={{ color: status === "healthy" ? undefined : "var(--err-fg)", marginTop: 4 }}>Last error {ago(h.lastErrorAt)}: {h.lastError}</div>
        )}
      </div>
    </div>
  );
}

/** One series, one hue: a column per day, value on hover and on the latest day. */
function DayBars({ days, values }: { days: string[]; values: number[] }) {
  const max = Math.max(1, ...values);
  const W = 100 / days.length;
  return (
    <div>
      <div className="daybars" role="img" aria-label={`Messages per day: ${days.map((d, i) => `${d} ${values[i]}`).join(", ")}`}>
        {values.map((v, i) => (
          <div key={days[i]} className="daybar" style={{ width: `${W}%` }} title={`${new Date(days[i] + "T12:00:00Z").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}: ${v} message${v === 1 ? "" : "s"}`}>
            {i === values.length - 1 && <span className="daybar-v mono">{v}</span>}
            <i style={{ height: `${Math.max(v ? 4 : 0, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
        {days.map((d, i) => <span key={d} style={{ width: `${W}%`, textAlign: "center" }}>{i === days.length - 1 ? "Today" : new Date(d + "T12:00:00Z").toLocaleDateString([], { weekday: "short" })}</span>)}
      </div>
    </div>
  );
}

/** A share of the whole, on a single-hue track. */
function Meter({ label, value, total }: { label: string; value: number; total: number }) {
  const p = total ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", fontSize: 13 }}><span>{label}</span><span className="mono">{value} · {p}%</span></div>
      <div className="bar" style={{ marginTop: 4 }} role="meter" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}><i style={{ width: `${p}%` }} /></div>
    </div>
  );
}
