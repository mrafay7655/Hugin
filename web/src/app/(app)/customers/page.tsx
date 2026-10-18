"use client";

import { useState } from "react";
import { ChevronLeft, Sparkles } from "lucide-react";
import { useCollection } from "@/lib/data";
import type { Conversation, Customer } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Avatar, CHANNELS, Loading, ago, human } from "@/components/ui";

export default function CustomersPage() {
  const { data: customers, loading } = useCollection<Customer>("customers");
  const { data: convs } = useCollection<Conversation>("conversations");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const list = customers.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const cur = list.find((c) => c.id === sel) ?? list[0];
  if (loading) return <Loading />;
  return (
    <>
      <Topbar title="Customers" />
      <div className="page g-customers">
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: 12 }}><input className="input" placeholder="Search customers" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {list.length === 0 && <div className="empty">No customers match.</div>}
          {list.map((c) => (
            <button key={c.id} className={"li" + (c.id === cur?.id ? " on" : "")} onClick={() => setSel(c.id)}>
              <Avatar c={c} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="nm"><span className="ellipsis">{c.name}</span>{c.sample && <span className="b-sample">SAMPLE</span>}</div>
                <div className="pv ellipsis">{c.tier}{c.city ? ` · ${c.city}` : ""}</div>
              </div>
              <span className={"badge " + (c.churn === "High" ? "b-err" : c.churn === "Medium" ? "b-warn" : "b-ok")}>{c.churn}</span>
            </button>
          ))}
        </div>

        {cur && (
          <div className={"sheet" + (sel ? " open" : "")}>
            <div className="sheet-bar">
              <button className="btn ghost icon" onClick={() => setSel(null)} aria-label="Back to customers"><ChevronLeft size={20} /></button>
              {cur.name}
            </div>
            <div className="sheet-in">
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="row" style={{ gap: 12 }}>
                  <Avatar c={cur} size="lg" />
                  <div><b style={{ fontSize: 16 }}>{cur.name}</b><div className="faint" style={{ fontSize: 12.5 }}>{cur.tier} · customer since {cur.since} · {cur.segment}</div></div>
                </div>
                <div>
                  <div className="kv"><span>Phone</span><span className="mono">{cur.phoneMasked}</span></div>
                  {cur.handle && <div className="kv"><span>Handle</span><span>{cur.handle}</span></div>}
                  <div className="kv"><span>Location</span><span>{cur.city || "—"}</span></div>
                  <div className="kv"><span>Language</span><span>{cur.language}</span></div>
                  <div className="kv"><span>CSAT</span><span>{cur.csat} / 5</span></div>
                </div>
                {cur.summary && <div className="sunk"><div className="row" style={{ gap: 5, color: "var(--a700)", fontWeight: 500, fontSize: 12.5, marginBottom: 4 }}><Sparkles size={13} />Summary</div><div style={{ fontSize: 13, lineHeight: 1.5 }}>{cur.summary}</div></div>}
                {cur.traits.length > 0 && <div><h4 style={{ margin: "0 0 8px" }}>Communication style</h4><div className="row" style={{ flexWrap: "wrap", gap: 5 }}>{cur.traits.map((t) => <span key={t} className="chip">{t}</span>)}</div></div>}
                <div>
                  <h4 style={{ margin: "0 0 8px" }}>Conversations</h4>
                  {convs.filter((v) => v.customerId === cur.id).length === 0 && <span className="faint" style={{ fontSize: 12.5 }}>No conversations yet</span>}
                  {convs.filter((v) => v.customerId === cur.id).map((v) => (
                    <div key={v.id} className="kv"><span><span className="dot" style={{ background: CHANNELS[v.channel]?.color, display: "inline-block", marginRight: 6 }} />{CHANNELS[v.channel]?.label} · {human(v.intent)}</span><span className="faint">{ago(v.lastAt)}</span></div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
