"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles, UserRoundCheck, X } from "lucide-react";
import { useSession } from "@/lib/auth";
import { call, useCollection } from "@/lib/data";
import { useAction } from "@/lib/toast";
import type { Conversation, Customer, WithId } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Avatar, ChannelBadge, Empty, Loading, ago, human } from "@/components/ui";

export default function ApprovalsPage() {
  const { data: convs, loading } = useCollection<Conversation>("conversations");
  const { data: customers } = useCollection<Customer>("customers");
  const pending = convs.filter((c) => c.approval).sort((a, b) => a.approval!.createdAt - b.approval!.createdAt);
  if (loading) return <Loading />;
  return (
    <>
      <Topbar title="Approvals" />
      <div className="page page-narrow" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>Drafts the agent is not allowed to send on its own. Nothing here reaches a customer until you approve it.</p>
        {pending.length === 0 && <Empty icon={UserRoundCheck} title="Nothing waiting">Every draft has been reviewed.</Empty>}
        {pending.map((c) => <Row key={c.id} c={c} cu={customers.find((x) => x.id === c.customerId)} />)}
      </div>
    </>
  );
}

function Row({ c, cu }: { c: WithId<Conversation>; cu?: WithId<Customer> }) {
  const s = useSession();
  const act = useAction();
  const [text, setText] = useState(c.approval!.draft);
  const [busy, setBusy] = useState(false);
  const locked = s.role === "judge" && c.transport !== "sim" && c.transport !== "telegram"; // a judge may act on simulated and Telegram demo chats, not WhatsApp
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); await act(fn, ok); setBusy(false); };
  return (
    <div className="card">
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <Avatar c={cu} size="sm" />
        <b style={{ fontWeight: 500 }}>{cu?.name ?? c.customerId}</b>
        <ChannelBadge ch={c.channel} />
        <span className="badge b-warn">{c.approval!.reason}</span>
        <span className="faint" style={{ fontSize: 12 }}>{human(c.intent)} · waiting {ago(c.approval!.createdAt)}</span>
        <Link className="btn ghost sm" style={{ marginLeft: "auto" }} href={`/inbox?c=${encodeURIComponent(c.id)}`}>Open thread</Link>
      </div>
      <div className="sunk" style={{ fontSize: 13, marginBottom: 10 }}><span className="faint">Customer: </span>{c.lastPreview}</div>
      <div className="row" style={{ gap: 5, color: "var(--a700)", fontSize: 12, marginBottom: 4 }}><Sparkles size={12} />Draft</div>
      <textarea className="input" rows={3} value={text} disabled={locked} aria-label="Draft reply" onChange={(e) => setText(e.target.value)} />
      {locked && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Judges can act on simulated and Telegram demo conversations, not on WhatsApp ones.</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn ghost sm" disabled={busy || locked} onClick={() => run(() => call("rejectDraft", { convId: c.id, reason: "Rejected from approvals" }), "Rejected · you're in control")}><X size={14} />Reject</button>
        <button className="btn primary sm" disabled={busy || locked || !text.trim()} onClick={() => run(() => call("approveDraft", { convId: c.id, ...(text !== c.approval!.draft ? { text } : {}) }), "Approved and sent")}>Approve and send</button>
      </div>
    </div>
  );
}
