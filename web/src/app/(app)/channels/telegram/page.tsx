"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink, FlaskConical, Image as ImageIcon, Mic, Send, Smartphone } from "lucide-react";
import { call, useCollection } from "@/lib/data";
import { useAction } from "@/lib/toast";
import type { Conversation, Customer, Message, Trace, WithId } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { DecisionBadge, Empty, Loading, Stat, human, timeAgo, useTick, within } from "@/components/ui";

const BOT = "ravenwood_hugin_bot";
const BOT_URL = `https://t.me/${BOT}`;
/** The web fallback writes as this seeded customer, on the Telegram channel, through the simulator. */
const FALLBACK_CUSTOMER = "c10";

const TRY: { label: string; text?: string; hint?: string; icon?: typeof Mic }[] = [
  { label: "OTP scam call", text: "Someone called saying they're from Ravenwood and asked for my one-time code. I didn't give it. Is my account safe?" },
  { label: "Phishing link", text: "Got a text saying my account is LOCKED, verify at ravenw00d-verify.com. Is this you?" },
  { label: "Fee question", text: "What's the fee for an international wire?" },
  { label: "Lost card", text: "I think I lost my card at the gym" },
  { label: "Voice note", hint: "Hold the mic in Telegram and ask about a fee, or describe a scam call.", icon: Mic },
  { label: "Screenshot", hint: "Send a screenshot of any suspicious text message.", icon: ImageIcon },
];

/** "Muhammad Rafay" → "Muhammad R." Judges' full names are not shown on a shared screen. */
const shortName = (n: string) => {
  const parts = n.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] || "Telegram user";
};

function Bubble({ m }: { m: WithId<Message> }) {
  const mine = m.dir === "out";
  const label = m.kind === "voice" ? `🎤 Voice note${m.transcript ? `: "${m.transcript}"` : ""}` : m.kind === "image" ? `🖼 Screenshot${m.text ? `: ${m.text}` : ""}` : m.text;
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
      <div style={{ maxWidth: "82%", padding: "7px 11px", borderRadius: 12, fontSize: 13, lineHeight: 1.45, background: mine ? (m.author === "human" ? "var(--n100)" : "var(--a50)") : "var(--sunken)", whiteSpace: "pre-wrap" }}>
        {mine && <div className="faint" style={{ fontSize: 10.5, marginBottom: 2 }}>{m.author === "human" ? m.authorName ?? "Staff" : "HUGIN"}</div>}
        {label.length > 260 ? `${label.slice(0, 260)}…` : label}
      </div>
    </div>
  );
}

function LiveChat({ conv, name }: { conv: WithId<Conversation>; name: string }) {
  const msgs = useCollection<Message>(`conversations/${conv.id}/messages`, { order: ["at", "asc"] }).data;
  const t = useCollection<Trace>(`conversations/${conv.id}/traces`, { order: ["at", "desc"], limit: 1 }).data[0];
  const actions = t?.tools.filter((x) => ["lock_card", "create_case", "create_approval"].includes(x)) ?? [];
  return (
    <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="dot" style={{ background: "#2AA3D6" }} />
        <b style={{ fontWeight: 500 }}>{shortName(name)}</b>
        <span className="faint" style={{ fontSize: 12 }}>Telegram · {timeAgo(conv.lastAt)}</span>
        <span style={{ marginLeft: "auto" }}><DecisionBadge d={conv.decision} pulse={conv.thinking} /></span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {msgs.slice(-4).map((m) => <Bubble key={m.id} m={m} />)}
        {conv.thinking && <div className="faint" style={{ fontSize: 12 }}>HUGIN is thinking…</div>}
      </div>
      {t && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", borderTop: "1px solid var(--n100)", paddingTop: 8, fontSize: 12 }}>
          <span className={"badge " + (t.source === "gemini" ? "b-acc" : "b-n")}>{t.source === "gemini" ? "Gemini" : "Rules"}</span>
          <span className="chip">{human(t.intent)}</span>
          <span className="chip mono">{t.policyId}</span>
          {actions.map((a) => <span key={a} className="chip mono">✓ {a}</span>)}
          {conv.caseId && <span className="badge b-err mono">{conv.caseId}</span>}
          <span className="faint">{(t.latencyMs / 1000).toFixed(1)}s</span>
          <Link href={`/agent?run=${t.id}`} className="faint" style={{ marginLeft: "auto", textDecoration: "underline" }}>Replay in Agent console</Link>
        </div>
      )}
    </div>
  );
}

function WebFallback() {
  const act = useAction();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const msgs = useCollection<Message>(`conversations/${FALLBACK_CUSTOMER}_telegram/messages`, { order: ["at", "asc"] }).data;
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    if (await act(() => call("simulateInbound", { customerId: FALLBACK_CUSTOMER, channel: "telegram", text: text.trim() }), "Sent, HUGIN is replying")) setText("");
    setBusy(false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="banner" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", fontSize: 12.5 }}>Simulated: the same agent and Gemini, but the message does not go through Telegram.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
        {msgs.length === 0 ? <span className="faint" style={{ fontSize: 12.5 }}>No messages yet.</span> : msgs.slice(-6).map((m) => <Bubble key={m.id} m={m} />)}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} placeholder="Type as a customer…" aria-label="Simulated message" />
        <button className="btn primary sm" disabled={busy || !text.trim()} onClick={send}><Send size={14} />Send</button>
      </div>
    </div>
  );
}

export default function TelegramLivePage() {
  useTick(15000);
  const convs = useCollection<Conversation>("conversations", { order: ["lastAt", "desc"], limit: 60 });
  const customers = useCollection<Customer>("customers").data;
  const [copied, setCopied] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  if (convs.loading) return <Loading />;

  const live = convs.data.filter((c) => c.transport === "telegram");
  const recent = live.some((c) => within(c.lastAt, 24 * 3600_000));
  const nameOf = (c: Conversation) => customers.find((x) => x.id === c.customerId)?.name ?? "Telegram user";
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked: the text is visible anyway */ }
  };

  return (
    <>
      <Topbar title="Telegram · live bot">
        <a className="btn primary sm" href={BOT_URL} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open @{BOT}</a>
      </Topbar>
      <div className="page" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="row" style={{ gap: 6, fontSize: 13 }}>
          <Link href="/channels" className="faint">Channels</Link><span className="faint">›</span><b style={{ fontWeight: 500 }}>Telegram</b>
          {recent ? <span className="badge b-ok" style={{ marginLeft: 6 }}>Live · messages in the last 24 hours</span> : <span className="badge b-n" style={{ marginLeft: 6 }}>Ready · no messages in the last 24 hours</span>}
        </div>
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>
          This is the real bot. Message it from your own phone and watch HUGIN read the message with Gemini, decide under bank policy and act, here, in seconds.
        </p>

        <div className="g-stats3">
          <Stat label="Live Telegram chats" value={live.length} sub="real people messaging the bot" />
          <Stat label="Escalated to fraud" value={live.filter((c) => c.status === "fraud").length} sub="card locked, case opened" />
          <Stat label="Fraud cases opened" value={live.filter((c) => c.caseId).length} sub="each with a case number" />
        </div>

        <div className="tg-grid">
          <div className="card tg-sticky" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="row" style={{ gap: 8 }}><Smartphone size={16} /><b>Try it yourself</b></div>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/telegram-qr.svg" alt={`QR code for ${BOT_URL}`} width={150} height={150} style={{ borderRadius: 10, background: "#fff", padding: 6, boxShadow: "var(--e1)" }} />
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
                <li>Scan the code, or <a href={BOT_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>open @{BOT}</a></li>
                <li>Press <b>Start</b></li>
                <li>Send one of the messages below</li>
              </ol>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {TRY.map((x) => {
                const Icon = x.icon;
                return (
                  <div key={x.label} className="row" style={{ gap: 8, background: "var(--sunken)", borderRadius: 10, padding: "8px 10px", alignItems: "flex-start" }}>
                    <div className="grow" style={{ fontSize: 12.5 }}>
                      <b style={{ fontWeight: 500 }}>{Icon && <Icon size={12} style={{ verticalAlign: -1, marginRight: 4 }} />}{x.label}</b>
                      <div className="faint" style={{ marginTop: 2 }}>{x.text ? `"${x.text}"` : x.hint}</div>
                    </div>
                    {x.text && (
                      <button className="btn ghost sm" onClick={() => copy(x.label, x.text!)} aria-label={`Copy ${x.label}`}>
                        {copied === x.label ? <><Check size={13} />Copied</> : <><Copy size={13} />Copy</>}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ borderTop: "1px solid var(--n100)", paddingTop: 12 }}>
              <button className="btn ghost sm" onClick={() => setFallback((f) => !f)}><FlaskConical size={14} />{fallback ? "Hide the web chat" : "No Telegram? Chat here instead"}</button>
              {fallback && <div style={{ marginTop: 10 }}><WebFallback /></div>}
            </div>
            <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.5 }}>Privacy: messages to this demo bot are read by the HUGIN agent and by Google Gemini, shown to the team on this screen with names shortened, and deleted automatically after 30 days. Please do not send real account details. Each chat is limited to 30 messages an hour.</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="dot" style={{ background: "var(--ok, #17763F)", boxShadow: "0 0 0 4px var(--ok-bg)" }} />
              <b>Live conversations</b>
              <span className="faint" style={{ fontSize: 12.5 }}>update as people message the bot</span>
            </div>
            {live.length === 0 ? (
              <Empty icon={Smartphone} title="Waiting for the first message">Scan the code and send a message. It appears here within seconds.</Empty>
            ) : (
              live.slice(0, 6).map((c) => <LiveChat key={c.id} conv={c} name={nameOf(c)} />)
            )}
          </div>
        </div>
      </div>
    </>
  );
}
