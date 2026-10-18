"use client";

import { useState } from "react";
import { MessageSquareText, RotateCcw, Send } from "lucide-react";
import { useIsJudge } from "@/lib/auth";
import { call, useCollection, useDoc } from "@/lib/data";
import { useAction } from "@/lib/toast";
import type { Channel, CommentPlatform, Customer, Org } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { CHANNELS, PLATFORMS } from "@/components/ui";

const SCRIPTS: { label: string; customerId: string; channel: Channel; text: string; viaButton?: boolean }[] = [
  { label: "OTP scam report", customerId: "c1", channel: "whatsapp", text: "Someone just called saying they're from the bank and asked for my one-time code. I didn't give it. Is my account safe?" },
  { label: "Phishing link check", customerId: "c3", channel: "whatsapp", text: "Got a text saying my account is LOCKED, verify at ravenw00d-verify.com. Is this you?" },
  { label: "Then tap “Yes, I did”", customerId: "c3", channel: "whatsapp", text: "Yes, I did", viaButton: true },
  { label: "Fee question", customerId: "c2", channel: "instagram", text: "What's the fee for an international wire?" },
  { label: "Account change", customerId: "c4", channel: "whatsapp", text: "I need to change the phone number on my account." },
  { label: "No approved source", customerId: "c10", channel: "telegram", text: "Do you offer crypto custody accounts?" },
  { label: "Not fraud: forgot PIN", customerId: "c6", channel: "telegram", text: "I forgot my PIN, can someone call me?" },
];
const COMMENT_SCRIPTS: { label: string; platform: CommentPlatform; text: string }[] = [
  { label: "Scam giveaway", platform: "instagram", text: "You've won a $500 giveaway! Claim now at ravenw00d-prizes.com" },
  { label: "Sarcastic outage", platform: "instagram", text: "Great, the app is down again on payday, thanks a lot 🙃" },
  { label: "Praise", platform: "facebook", text: "Customer service called me back in 10 minutes. Impressed!" },
  { label: "Legal threat", platform: "facebook", text: "I will report you to the CFPB if my money isn't back by Friday" },
];

export default function DemoPage() {
  const act = useAction();
  const judge = useIsJudge();
  const org = useDoc<Org>("").data;
  const customers = useCollection<Customer>("customers").data.filter((c) => c.sample); // simulated messages go to sample customers only
  const [customerId, setCustomerId] = useState("c1");
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [text, setText] = useState("");
  const [viaButton, setViaButton] = useState(false);
  const [platform, setPlatform] = useState<CommentPlatform>("instagram");
  const [comment, setComment] = useState("");
  const off = org && !org.demoMode;

  return (
    <>
      <Topbar title="Demo control">
        {!judge && (
          <button className="btn secondary sm" disabled={!!off} onClick={() => confirm("Restore the sample conversations, customers, knowledge, policy and comments?\n\nReal conversations, real comments and who can sign in are kept.") && act(() => call("resetDemo"), "Sample data restored")}><RotateCcw size={14} />Reset sample data</button>
        )}
      </Topbar>
      <div className="page page-narrow" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {off && <div className="banner" style={{ background: "var(--warn-bg)" }}>Demo tools are disabled for this workspace.</div>}
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>Simulated messages run through the exact same agent, policy and guards as real WhatsApp and Telegram traffic. They are labelled SIMULATED, go to sample customers only, and never reach Meta or Telegram.</p>

        <div className="card">
          <h3 style={{ margin: "0 0 10px" }}><Send size={14} style={{ verticalAlign: -2 }} /> Send a customer message</h3>
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {SCRIPTS.map((s) => <button key={s.label} className="chip" onClick={() => { setCustomerId(s.customerId); setChannel(s.channel); setText(s.text); setViaButton(!!s.viaButton); }}>{s.label}</button>)}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <select className="input" style={{ flex: "1 1 160px" }} value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Customer">
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input" style={{ flex: "1 1 140px" }} value={channel} onChange={(e) => setChannel(e.target.value as Channel)} aria-label="Channel">
              {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <textarea className="input" rows={3} style={{ marginTop: 8 }} value={text} aria-label="What the customer says" onChange={(e) => { setText(e.target.value); setViaButton(false); }} placeholder="What the customer says…" />
          <div className="row" style={{ justifyContent: "space-between", marginTop: 8, flexWrap: "wrap" }}>
            <span className="faint" style={{ fontSize: 12 }}>{viaButton ? "Sent as a tap on the agent's “Yes, I did” button" : "Sent as typed text"}</span>
            <button className="btn primary sm" disabled={!text.trim() || !!off} onClick={async () => { if (await act(() => call("simulateInbound", { customerId, channel, text, ...(viaButton ? { viaButton: true } : {}) }), "Sent · watch the Inbox")) { setText(""); setViaButton(false); } }}>Send as customer</button>
          </div>
        </div>

        <div className="card">
          <h3 style={{ margin: "0 0 10px" }}><MessageSquareText size={14} style={{ verticalAlign: -2 }} /> Post a public comment</h3>
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
            {COMMENT_SCRIPTS.map((s) => <button key={s.label} className="chip" onClick={() => { setPlatform(s.platform); setComment(s.text); }}>{s.label}</button>)}
          </div>
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as CommentPlatform)} aria-label="Platform">
            {Object.entries(PLATFORMS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <textarea className="input" rows={2} style={{ marginTop: 8 }} value={comment} aria-label="The comment" onChange={(e) => setComment(e.target.value)} placeholder="The comment…" />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button className="btn primary sm" disabled={!comment.trim() || !!off} onClick={async () => { if (await act(() => call("simulateComment", { platform, text: comment, postLabel: "Demo post" }), "Comment classified · see Moderation")) setComment(""); }}>Post comment</button>
          </div>
        </div>
      </div>
    </>
  );
}
