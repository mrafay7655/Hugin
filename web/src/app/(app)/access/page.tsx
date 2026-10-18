"use client";

import { useState } from "react";
import { Globe, Mail, X } from "lucide-react";
import { useIsJudge, useSession } from "@/lib/auth";
import { call, useCollection, useDoc } from "@/lib/data";
import { useAction } from "@/lib/toast";
import type { Org } from "@/lib/types";
import { Topbar } from "@/components/shell";
import { Loading, ReadOnlyNote, ago } from "@/components/ui";

export default function AccessPage() {
  const s = useSession();
  const judge = useIsJudge();
  const act = useAction();
  const { data: org, loading } = useDoc<Org>("");
  const { data: invites } = useCollection<{ by: string; at: number; role?: "manager" | "judge" }>("invites");
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"manager" | "judge">("manager");
  if (loading || !org) return <Loading />;
  return (
    <>
      <Topbar title="Access" />
      <div className="page page-narrow" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {judge && <ReadOnlyNote what="who has access" />}
        <p className="muted" style={{ fontSize: 13.5, margin: 0 }}>There is no public sign-up. People can sign in only with a verified email on an approved domain, or an email you invite. A manager can change anything. A judge can look around and try the demo on simulated data only.</p>
        <div className="card">
          <h3 style={{ margin: "0 0 10px" }}><Globe size={14} style={{ verticalAlign: -2 }} /> Approved domains</h3>
          {org.allowedDomains.length === 0 && <div className="faint" style={{ fontSize: 13 }}>No approved domains. Only invited people can sign in.</div>}
          {org.allowedDomains.map((d) => (
            <div key={d} className="kv" style={{ alignItems: "center" }}><span className="mono">@{d}</span>{!judge && <button className="btn ghost icon sm" aria-label={`Remove ${d}`} onClick={() => act(() => call("removeAllowedDomain", { domain: d }), `Removed ${d} · their sessions ended`)}><X size={14} /></button>}</div>
          ))}
          {!judge && (
            <>
              <form className="row" style={{ marginTop: 10 }} onSubmit={async (e) => { e.preventDefault(); if (await act(() => call("addAllowedDomain", { domain }), `Approved ${domain}`)) setDomain(""); }}>
                <input className="input grow" placeholder="bankname.com" aria-label="Domain to approve" value={domain} onChange={(e) => setDomain(e.target.value)} />
                <button className="btn primary sm" disabled={!domain.trim()}>Approve domain</button>
              </form>
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Public mail providers such as gmail.com cannot be approved. Removing a domain ends its people&apos;s sessions straight away.</div>
            </>
          )}
        </div>
        <div className="card">
          <h3 style={{ margin: "0 0 10px" }}><Mail size={14} style={{ verticalAlign: -2 }} /> Invited people</h3>
          {invites.length === 0 && <div className="faint" style={{ fontSize: 13 }}>No individual invites.</div>}
          {invites.map((i) => (
            <div key={i.id} className="kv" style={{ alignItems: "center" }}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{i.id} <span className={"badge " + (i.role === "judge" ? "b-warn" : "b-out")}>{i.role ?? "manager"}</span> <span className="faint" style={{ fontSize: 12 }}>· by {i.by} {ago(i.at)}</span></span>
              {!judge && i.id !== s.email.toLowerCase() && <button className="btn ghost icon sm" aria-label={`Remove ${i.id}`} onClick={() => act(() => call("removeInvite", { email: i.id }), "Invite removed · their session ended")}><X size={14} /></button>}
            </div>
          ))}
          {!judge && (
            <form style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }} onSubmit={async (e) => { e.preventDefault(); if (await act(() => call("addInvite", { email, role }), `Invited ${email} as ${role}`)) setEmail(""); }}>
              <input className="input" style={{ flex: "1 1 200px" }} type="email" placeholder="name@company.com" aria-label="Email to invite" value={email} onChange={(e) => setEmail(e.target.value)} />
              <select className="input" style={{ flex: "0 0 120px" }} value={role} onChange={(e) => setRole(e.target.value as "manager" | "judge")} aria-label="Role">
                <option value="manager">Manager</option>
                <option value="judge">Judge</option>
              </select>
              <button className="btn primary sm" disabled={!email.trim()}>Invite</button>
            </form>
          )}
        </div>
        <div className="faint" style={{ fontSize: 12 }}>You are signed in as {s.email} ({s.role}).</div>
      </div>
    </>
  );
}
