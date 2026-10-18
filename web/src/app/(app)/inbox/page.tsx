"use client";

import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCheck, ChevronLeft, CreditCard, Hand, Inbox as InboxIcon, Info, Lock, ShieldAlert, Sparkles, Unlock, X } from "lucide-react";
import { useSession } from "@/lib/auth";
import { call, markRead, useCollection, useDoc } from "@/lib/data";
import { useAction } from "@/lib/toast";
import { useQuery } from "@/lib/url-state";
import type { Conversation, Customer, Message, Trace, WithId } from "@/lib/types";
import { Avatar, CHANNELS, ChannelBadge, DecisionBadge, Empty, Loading, OriginBadge, TraceCard, ago, clock, human, originOf, timeAgo, useTick } from "@/components/ui";

type Tab = "all" | "mine" | "human" | "fraud" | "resolved";

/** WhatsApp only allows free-form replies for 24 hours after the customer's last message. */
const windowExpired = (lastCustomerMessageAt: number) => Date.now() - lastCustomerMessageAt > 24 * 3600_000;

const JUDGE_NOTE = "Judges can act on simulated and Telegram demo conversations, not on WhatsApp ones.";

export default function InboxPage() {
  return (
    <Suspense fallback={<Loading />}>
      <InboxScreen />
    </Suspense>
  );
}

function InboxScreen() {
  useTick(20000);
  const s = useSession();
  const q = useQuery();
  const { data: convs, loading } = useCollection<Conversation>("conversations");
  const { data: customers } = useCollection<Customer>("customers");
  const [tab, setTab] = useState<Tab>("all");
  const [chan, setChan] = useState("all");
  // Seeded sample conversations are hidden for a judge by default, so their own live and simulated ones stand out.
  const [hideSample, setHideSample] = useState(s.role === "judge");
  const [ctx, setCtx] = useState(true); // the customer column on a wide screen
  const [sheet, setSheet] = useState(false); // the customer sheet on a phone
  const byId = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);

  const filtered = useMemo(() => {
    const f = convs.filter((c) => {
      if (chan !== "all" && c.channel !== chan) return false;
      if (hideSample && originOf(c) === "sample") return false;
      if (tab === "all") return c.status !== "resolved";
      if (tab === "mine") return c.assignee === s.name;
      if (tab === "human") return !!c.approval || c.status === "needs_human";
      if (tab === "fraud") return c.status === "fraud" || c.decision === "phishing";
      return c.status === "resolved";
    });
    return f.sort((a, b) => (b.status === "fraud" ? 1 : 0) - (a.status === "fraud" ? 1 : 0) || b.lastAt - a.lastAt);
  }, [convs, tab, chan, s.name, hideSample]);

  const counts = {
    all: convs.filter((c) => c.status !== "resolved").length,
    human: convs.filter((c) => c.approval || c.status === "needs_human").length,
    fraud: convs.filter((c) => c.status === "fraud" || c.decision === "phishing").length,
  };

  // The chosen conversation lives in the URL (?c=), so refresh, a shared link and a phone's back gesture all work.
  // On a phone nothing chosen means the list; a wide screen shows the first conversation instead.
  const chosen = convs.find((c) => c.id === q.get("c", ""));
  const current = chosen ?? filtered[0];
  const open = (id: string) => q.set({ c: id }, { push: true });
  const back = () => q.set({ c: null });

  useEffect(() => {
    if (current?.unread && chosen) markRead(s.orgId, current.id);
  }, [current?.id, current?.unread, chosen, s.orgId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const i = filtered.findIndex((c) => c.id === current?.id);
      if (e.key === "j" && filtered[i + 1]) q.set({ c: filtered[i + 1].id });
      if (e.key === "k" && i > 0) q.set({ c: filtered[i - 1].id });
      if (e.key === "]") setCtx((x) => !x);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, current]);

  if (loading) return <Loading />;
  return (
    <div className={"inbox" + (ctx ? "" : " noctx")} data-view={chosen ? "thread" : "list"}>
      <div className="list">
        <div className="list-head">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <b style={{ fontSize: 17 }}>Inbox</b>
            <select className="input" style={{ width: 140 }} value={chan} onChange={(e) => setChan(e.target.value)} aria-label="Filter by channel">
              <option value="all">All channels</option>
              {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <label className="row" style={{ gap: 6, fontSize: 12.5, marginBottom: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={hideSample} onChange={(e) => setHideSample(e.target.checked)} />
            Hide sample data <span className="faint">(show only live and simulated)</span>
          </label>
          <div className="tabs">
            {([["all", "All", counts.all], ["mine", "Mine"], ["human", "Human", counts.human], ["fraud", "Fraud", counts.fraud], ["resolved", "Resolved"]] as [Tab, string, number?][]).map(([k, l, n]) => (
              <button key={k} className={"tab" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
                {l}
                {n ? <span className="cnt">{n}</span> : null}
              </button>
            ))}
          </div>
        </div>
        <div className="list-items">
          {filtered.length === 0 && <Empty icon={InboxIcon} title="Nothing here">HUGIN is handling everything in this view.</Empty>}
          {filtered.map((c) => {
            const cu = byId.get(c.customerId);
            return (
              <button key={c.id} className={"li" + (c.id === current?.id ? " on" : "") + (c.unread && c.id !== current?.id ? " unread" : "")} onClick={() => open(c.id)}>
                <Avatar c={cu} ch={c.channel} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="nm">
                    <span className="ellipsis">{cu?.name ?? c.customerId}</span>
                    <span className="mono faint" style={{ fontSize: 11, fontWeight: 400 }}>{timeAgo(c.lastAt)}</span>
                  </div>
                  <div className="pv ellipsis">{c.lastKind === "voice" ? "🎙 Voice message" : c.lastKind === "image" ? "📷 " + c.lastPreview : c.lastPreview}</div>
                  <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
                    {c.thinking ? <span className="badge b-acc"><Bot />Reasoning…</span> : <DecisionBadge d={c.decision} pulse={c.status === "fraud"} />}
                    {c.mode === "human" && <span className="badge b-out"><Hand />{c.assignee?.split(" ")[0]}</span>}
                    <OriginBadge o={originOf(c)} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
      {current ? (
        <Thread key={current.id} conv={current} customer={byId.get(current.customerId)} onBack={back} onCtx={() => { setCtx((x) => !x); setSheet((x) => !x); }} />
      ) : (
        <div className="thread"><div style={{ margin: "auto" }}><Empty icon={InboxIcon} title="Select a conversation" /></div></div>
      )}
      {sheet && <div className="ctx-bg" onClick={() => setSheet(false)} />}
      {current && (
        <Context
          conv={current}
          customer={byId.get(current.customerId)}
          others={convs.filter((v) => v.customerId === current.customerId && v.id !== current.id)}
          onOpen={(id) => { setSheet(false); open(id); }}
          onClose={() => setSheet(false)}
          sheet={sheet}
        />
      )}
    </div>
  );
}

function Thread({ conv, customer, onBack, onCtx }: { conv: WithId<Conversation>; customer?: WithId<Customer>; onBack: () => void; onCtx: () => void }) {
  const s = useSession();
  const act = useAction();
  const { data: msgs } = useCollection<Message>(`conversations/${conv.id}/messages`, { order: ["at", "asc"] });
  const { data: traces } = useCollection<Trace>(`conversations/${conv.id}/traces`, { order: ["at", "asc"] });
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const first = customer?.name.split(" ")[0] ?? "the customer";
  const human_ = conv.mode === "human";
  const judgeLocked = s.role === "judge" && conv.transport !== "sim" && conv.transport !== "telegram";

  useEffect(() => {
    box.current?.scrollTo({ top: 1e6, behavior: "smooth" });
  }, [msgs.length, traces.length, conv.thinking]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    const r = await act(fn, ok);
    setBusy(false);
    return r;
  };
  const send = async () => {
    const text = reply.trim();
    if (!text) return;
    if (await run(() => call("sendHumanMessage", { convId: conv.id, text }))) setReply("");
  };
  const windowClosed = conv.transport === "whatsapp" && conv.lastCustomerMessageAt != null && windowExpired(conv.lastCustomerMessageAt);
  const off = busy || judgeLocked;

  return (
    <div className="thread">
      <div className="thread-top">
        <button className="btn ghost icon m-only" onClick={onBack} aria-label="Back to the inbox"><ChevronLeft size={20} /></button>
        <div className="thread-who">
          <Avatar c={customer} size="sm" />
          <div style={{ minWidth: 0 }}>
            <b className="ellipsis" style={{ display: "block", lineHeight: 1.25 }}>{customer?.name ?? conv.customerId}</b>
            <div className="row" style={{ gap: 5, flexWrap: "nowrap", overflow: "hidden" }}>
              <ChannelBadge ch={conv.channel} />
              <DecisionBadge d={conv.decision} />
              {conv.caseId && <span className="badge b-err mono">{conv.caseId}</span>}
              <OriginBadge o={originOf(conv)} />
            </div>
          </div>
        </div>
        <div className="thread-actions">
          <button className="btn secondary icon sm" disabled={off} onClick={() => run(() => call("escalateToFraud", { convId: conv.id }), "Sent to Fraud · card locked")} title="Send to Fraud (locks the card)" aria-label="Send to Fraud"><ShieldAlert size={15} /></button>
          <button className="btn secondary icon sm" disabled={off} onClick={() => run(() => call("resolveConversation", { convId: conv.id }), "Resolved")} title="Resolve" aria-label="Resolve"><CheckCheck size={15} /></button>
          <button className={"btn icon sm " + (human_ ? "secondary" : "primary")} disabled={off} onClick={() => run(() => call("setConversationMode", { convId: conv.id, human: !human_ }))} title={human_ ? "Hand back to the agent" : "Take over from the agent"} aria-label={human_ ? "Hand back" : "Take over"}>
            <Hand size={15} />
          </button>
          <button className="btn ghost icon sm" onClick={onCtx} title="Customer details (])" aria-label="Customer details"><Info size={16} /></button>
        </div>
      </div>
      <div className="msgs" ref={box}>
        {msgs.map((m) => (
          <Fragment key={m.id}>
            {m.author === "system" ? (
              <div className="sys">{m.text}</div>
            ) : (
              <>
                <div className={"bub " + (m.dir === "in" ? "in" : m.author === "ai" ? "ai" : "human")}>
                  {m.author === "ai" && <div className="who"><Sparkles size={12} />HUGIN · auto-sent</div>}
                  {m.author === "human" && <div className="who">{m.authorName}</div>}
                  {m.kind === "image" && <div className="img">📷 Image{m.imageText ? " · " + m.imageText : ""}</div>}
                  {m.kind === "voice" && <div className="faint" style={{ fontSize: 12 }}>🎙 Voice note{m.voiceSecs ? ` · 0:${String(m.voiceSecs).padStart(2, "0")}` : ""} · transcript</div>}
                  <span style={{ whiteSpace: "pre-wrap" }}>{m.transcript || m.text}</span>
                  {m.buttons && <div className="row" style={{ marginTop: 6, gap: 5, flexWrap: "wrap" }}>{m.buttons.map((b) => <span key={b} className="chip" style={{ background: "#fff" }}>{b}</span>)}</div>}
                  {m.cite && <div><span className="cite">Source · {m.cite.doc} {m.cite.section}</span></div>}
                </div>
                <div className={"meta" + (m.dir === "out" ? " r" : "")}>
                  {clock(m.at)}
                  {m.dir === "out" && m.status ? " · " + m.status[0].toUpperCase() + m.status.slice(1) : ""}
                  {m.status === "failed" && m.error ? ` · ${m.error}` : ""}
                </div>
              </>
            )}
            {traces.filter((t) => t.afterMsg === m.id).map((t) => <TraceCard key={t.id} t={t} />)}
          </Fragment>
        ))}
        {conv.thinking && <div className="thinking"><i /><i /><i />HUGIN is reading the message</div>}
      </div>
      {judgeLocked && <div className="control-bar" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)" }}><Info size={14} />{JUDGE_NOTE}</div>}
      {human_ && !judgeLocked && (
        <div className="control-bar">
          <Hand size={14} />You&apos;re in control · the agent is paused here
          <button className="btn sm" style={{ marginLeft: "auto", background: "#fff", color: "var(--n900)" }} disabled={busy} onClick={() => run(() => call("setConversationMode", { convId: conv.id, human: false }))}>Hand back to agent</button>
        </div>
      )}
      {conv.approval ? (
        <ApprovalBox key={conv.approval.draft} convId={conv.id} approval={conv.approval} off={off} judgeLocked={judgeLocked} run={run} />
      ) : (
        <div className="composer">
          <textarea
            placeholder={judgeLocked ? "Judges cannot message real customers" : human_ ? `Reply to ${first}…` : "Reply as yourself, or let the agent handle it…"}
            value={reply}
            disabled={windowClosed || judgeLocked}
            aria-label="Reply"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 900px)").matches) { e.preventDefault(); send(); } }}
          />
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
            <span className="faint" style={{ fontSize: 12 }}>
              {windowClosed ? "WhatsApp's 24-hour reply window has closed. The customer must message first." : `${CHANNELS[conv.channel]?.label} · messages asking for codes or PINs are blocked`}
            </span>
            <button className="btn primary sm" disabled={off || !reply.trim() || windowClosed} onClick={send}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Context({ conv, customer: c, others, onOpen, onClose, sheet }: { conv: WithId<Conversation>; customer?: WithId<Customer>; others: WithId<Conversation>[]; onOpen: (id: string) => void; onClose: () => void; sheet: boolean }) {
  const s = useSession();
  const act = useAction();
  const card = useDoc<{ locked: boolean }>(`cards/${conv.customerId}`).data;
  const [busy, setBusy] = useState(false);
  const judgeLocked = s.role === "judge" && conv.transport !== "sim" && conv.transport !== "telegram";
  if (!c) return <div className={"ctx" + (sheet ? " open" : "")}><span className="faint">Unknown customer</span></div>;
  return (
    <div className={"ctx" + (sheet ? " open" : "")}>
      <div className="row" style={{ gap: 12 }}>
        <Avatar c={c} size="lg" />
        <div className="grow"><b style={{ fontSize: 15 }}>{c.name}</b><div className="faint" style={{ fontSize: 12.5 }}>{c.tier} · since {c.since}</div></div>
        <button className="btn ghost icon m-only" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div>
        <div className="kv"><span>Phone</span><span className="mono">{c.phoneMasked}</span></div>
        <div className="kv"><span>Location</span><span>{c.city || "—"}</span></div>
        <div className="kv"><span>Language</span><span>{c.language}</span></div>
        <div className="kv"><span>CSAT</span><span>{c.csat} / 5</span></div>
        <div className="kv"><span>Churn risk</span><span className={"badge " + (c.churn === "High" ? "b-err" : c.churn === "Medium" ? "b-warn" : "b-ok")}>{c.churn}</span></div>
      </div>
      {(card?.locked || conv.caseId) && (
        <div className="sunk" style={{ background: "var(--err-bg)", color: "#8F2424" }}>
          {card?.locked && (
            <div className="row" style={{ fontSize: 12.5, justifyContent: "space-between", flexWrap: "wrap" }}>
              <span className="row"><Lock size={14} />Card locked</span>
              <button
                className="btn secondary sm"
                disabled={busy || judgeLocked}
                title={judgeLocked ? JUDGE_NOTE : "Lift the lock. Only a person can do this."}
                onClick={async () => {
                  if (!window.confirm(`Unlock ${c.name}'s card? Do this only once you are sure the customer is safe.`)) return;
                  setBusy(true);
                  await act(() => call("unlockCard", { convId: conv.id }), "Card unlocked");
                  setBusy(false);
                }}
              >
                <Unlock size={13} />Unlock card
              </button>
            </div>
          )}
          {conv.caseId && <div className="row" style={{ fontSize: 12.5, marginTop: card?.locked ? 6 : 0 }}><CreditCard size={14} />Fraud case <b className="mono">{conv.caseId}</b></div>}
        </div>
      )}
      <div className="divider" />
      {c.traits?.length > 0 && <div><h4>Communication style</h4><div className="row" style={{ flexWrap: "wrap", gap: 5 }}>{c.traits.map((t) => <span key={t} className="chip">{t}</span>)}</div></div>}
      <div>
        <h4>Across channels</h4>
        <div className="col" style={{ gap: 8 }}>
          {others.length === 0 && <span className="faint" style={{ fontSize: 12.5 }}>No other conversations</span>}
          {others.map((o) => (
            <button key={o.id} className="row" style={{ textAlign: "left", fontSize: 13, alignItems: "flex-start", minHeight: 36 }} onClick={() => onOpen(o.id)}>
              <span className="dot" style={{ background: CHANNELS[o.channel]?.color, marginTop: 5 }} />
              <span>{CHANNELS[o.channel]?.label} · {ago(o.lastAt)}<br /><span className="faint">{human(o.intent)}</span></span>
            </button>
          ))}
        </div>
      </div>
      {c.summary && <div className="sunk"><div className="row" style={{ gap: 5, color: "var(--a700)", fontWeight: 500, fontSize: 12.5, marginBottom: 4 }}><Sparkles size={13} />Summary</div><div style={{ fontSize: 13, lineHeight: 1.5 }}>{c.summary}</div></div>}
    </div>
  );
}

/** The draft the agent is not allowed to send alone. Keyed by the draft text, so it starts fresh whenever the draft changes. */
function ApprovalBox({ convId, approval, off, judgeLocked, run }: { convId: string; approval: { draft: string; reason: string }; off: boolean; judgeLocked: boolean; run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(approval.draft);
  const [editing, setEditing] = useState(false);
  return (
    <div className="composer">
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        <span className="badge b-acc"><Sparkles />Draft ready</span>
        <span className="badge b-warn">{approval.reason}</span>
        <span className="faint" style={{ fontSize: 12 }}>The agent won&apos;t send this without you</span>
      </div>
      {editing ? <textarea className="input" rows={3} value={draft} aria-label="Edit the draft" onChange={(e) => setDraft(e.target.value)} autoFocus /> : <div style={{ color: "var(--text-2)", lineHeight: 1.55 }}>{approval.draft}</div>}
      <div className="row" style={{ marginTop: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button className="btn ghost sm" disabled={off} onClick={() => run(() => call("rejectDraft", { convId, reason: "Rejected by manager" }), "Draft rejected · you're in control")}><X size={14} />Reject</button>
        <button className="btn secondary sm" disabled={judgeLocked} onClick={() => setEditing((e) => !e)}>{editing ? "Preview" : "Edit"}</button>
        <button className="btn primary sm" disabled={off || (editing && !draft.trim())} onClick={() => run(() => call("approveDraft", { convId, ...(editing ? { text: draft } : {}) }), "Approved and sent")}>Approve and send</button>
      </div>
    </div>
  );
}
