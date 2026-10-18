"use client";

import { useState } from "react";
import { ScrollText } from "lucide-react";
import { useCollection } from "@/lib/data";
import type { AuditEntry } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Empty, Loading } from "@/components/ui";

const badge = (a: { action: string; actor: string; value: string | null }) => "badge " + (a.action === "blocked" ? "b-err" : a.actor === "HUGIN" || a.actor === "agent" || a.value === "ai" ? "b-acc" : "b-out");

export default function AuditPage() {
  const { data, loading } = useCollection<AuditEntry>("audit", { order: ["at", "desc"], limit: 300 });
  const [q, setQ] = useState("");
  const rows = data.filter((a) => `${a.actor} ${a.action} ${a.detail}`.toLowerCase().includes(q.toLowerCase()));
  if (loading) return <Loading />;
  return (
    <>
      <Topbar title="Audit log"><input className="input" style={{ width: 240 }} placeholder="Filter" aria-label="Filter the audit log" value={q} onChange={(e) => setQ(e.target.value)} /></Topbar>
      <div className="page">
        <p className="muted" style={{ fontSize: 13.5, margin: "0 0 12px" }}>Append-only. Every agent decision, blocked message and manager action is recorded here. Nobody, including managers, can edit or delete an entry.</p>
        {rows.length === 0 ? <Empty icon={ScrollText} title="No entries" /> : (
          <>
            {/* A phone reads cards, not a wide table. */}
            <div className="audit-cards card" style={{ padding: 0 }}>
              {rows.map((a) => (
                <div key={a.id} style={{ padding: "12px 14px", borderBottom: "1px solid var(--n100)" }}>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className={badge(a)}>{a.action}</span>
                    <span className="faint ellipsis" style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{a.actor}</span>
                    <span className="mono faint" style={{ fontSize: 11 }}>{new Date(a.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                  <div style={{ fontSize: 13.5, marginTop: 5, overflowWrap: "anywhere" }}>{a.detail}</div>
                </div>
              ))}
            </div>
            <div className="audit-table card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="t">
                  <thead><tr>{["Time", "Actor", "Action", "Detail"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id}>
                        <td className="mono" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{new Date(a.at).toLocaleString()}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{a.actor}</td>
                        <td><span className={badge(a)}>{a.action}</span></td>
                        <td>{a.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
