"use client";

import { useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { useIsJudge } from "@/lib/auth";
import { call, useCollection } from "@/lib/data";
import { useAction } from "@/lib/toast";
import type { KbDoc } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Loading, ReadOnlyNote } from "@/components/ui";

export default function KnowledgePage() {
  const act = useAction();
  const judge = useIsJudge();
  const { data: docs, loading } = useCollection<KbDoc>("kb");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sorted = [...docs].sort((a, b) => Number(a.status === "retired") - Number(b.status === "retired") || a.title.localeCompare(b.title));

  const add = async () => {
    setBusy(true);
    if (await act(() => call("addKnowledgeDoc", { title, text }), "Document added")) { setTitle(""); setText(""); setAdding(false); }
    setBusy(false);
  };
  if (loading) return <Loading />;
  return (
    <>
      <Topbar title="Knowledge">{!judge && <button className="btn primary sm" onClick={() => setAdding((a) => !a)}><Plus size={14} />Add document</button>}</Topbar>
      <div className="page page-narrow" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {judge && <ReadOnlyNote what="the knowledge the agent answers from" />}
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>The agent only answers from active documents and cites the section it used. Retired documents are never used.</p>
        {adding && (
          <div className="card">
            <label className="label" htmlFor="t">Title</label>
            <input id="t" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Savings Rates 2026" />
            <label className="label" htmlFor="x" style={{ marginTop: 10 }}>Content</label>
            <textarea id="x" className="input" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <button className="btn ghost sm" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary sm" disabled={busy || title.trim().length < 3 || text.trim().length < 10} onClick={add}>Add</button>
            </div>
          </div>
        )}
        {sorted.map((d) => (
          <div key={d.id} className="card" style={{ opacity: d.status === "retired" ? 0.6 : 1 }}>
            <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <BookOpen size={15} />
              <b style={{ fontWeight: 500 }}>{d.title}</b>
              <span className={"badge " + (d.status === "active" ? "b-ok" : "b-n")}>{d.status === "active" ? "Active" : "Retired"}</span>
              {!judge && (
                <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => act(() => call("setKnowledgeStatus", { docId: d.id, status: d.status === "active" ? "retired" : "active" }), d.status === "active" ? "Retired" : "Reactivated")}>
                  {d.status === "active" ? "Retire" : "Reactivate"}
                </button>
              )}
            </div>
            {d.sections.map((s) => (
              <div key={s.id} style={{ fontSize: 13, padding: "6px 0", borderTop: "1px solid var(--n100)" }}>
                <span className="mono faint" style={{ fontSize: 11.5 }}>{s.id}</span> <b style={{ fontWeight: 500 }}>{s.title}</b>
                <div className="muted" style={{ marginTop: 2 }}>{s.text}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
